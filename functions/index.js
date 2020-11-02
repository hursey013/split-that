"use strict";

const moment = require("moment");

// Init Firebase
const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

// Init Realtime Database
const db = admin.database();
const ref = db.ref("transactions");

// Init Plaid API
const plaid = require("plaid");
const plaidClient = new plaid.Client({
  clientID: functions.config().plaid.clientid,
  secret: functions.config().plaid.secret,
  env: plaid.environments.development
});

// Init Splitwise API
const Splitwise = require("splitwise");
const sw = Splitwise({
  consumerKey: functions.config().splitwise.key,
  consumerSecret: functions.config().splitwise.secret,
  accessToken: functions.config().splitwise.token
});

// Map transaction categories
const categoryTable = {
  13005000: 13, // Dining out
  13005032: 13, // Fast food
  19051000: 14, // Household supplies
  22009000: 33 // Gas/fuel
};

exports.events = functions.https.onRequest((request, response) => {
  functions.logger.info(JSON.stringify(request.body, null, 2));

  if (request.body.webhook_code === "DEFAULT_UPDATE") {
    const startDate = moment()
      .subtract(30, "days")
      .format("YYYY-MM-DD");
    const endDate = moment().format("YYYY-MM-DD");

    plaidClient
      // Fetch transactions from specified accounts for the last 30 days
      .getTransactions(functions.config().plaid.token, startDate, endDate, {
        account_ids: functions.config().plaid.account_ids.split(" ")
      })
      .then(res =>
        res.transactions
          // Filter out transactions that are less than $10
          .filter(transaction => transaction.amount >= 10)
          .map(processTransaction)
      )
      .catch(err => {
        if (err !== null) {
          functions.logger.error(
            err instanceof plaid.PlaidError
              ? err.error_code + ": " + err.error_message
              : err.toString()
          );
        }
      });
  } else if (request.body.webhook_code === "ERROR") {
    functions.logger.error(request.body.error);
  }

  response.sendStatus(200);
});

const processTransaction = transaction =>
  ref
    .child(transaction.transaction_id)
    .once("value")
    .then(
      snapshot =>
        // Filter out existing transactions
        !snapshot.exists() &&
        createExpense(transaction).then(([splitwise]) => {
          functions.logger.info(JSON.stringify(splitwise, null, 2));
          return ref
            .child(transaction.transaction_id)
            .set({ ...transaction, splitwise_id: splitwise.id });
        })
    );

const createExpense = transaction => {
  functions.logger.info(JSON.stringify(transaction, null, 2));

  const {
    amount,
    category_id,
    merchant_name,
    name,
    pending,
    pending_transaction_id
  } = transaction;

  const expense = {
    users: [
      {
        user_id: functions.config().splitwise.user1_id,
        paid_share: amount,
        owed_share: amount * Number(functions.config().splitwise.user1_share)
      },
      {
        user_id: functions.config().splitwise.user2_id,
        owed_share: amount * Number(functions.config().splitwise.user2_share)
      }
    ],
    cost: amount,
    description: `${sanitizeString(merchant_name || name)}${
      pending ? ` (pending)` : ""
    }`,
    group_id: functions.config().splitwise.group_id,
    category_id: categoryTable[category_id] || null
  };

  if (!pending && pending_transaction_id) {
    return ref
      .child(pending_transaction_id)
      .once("value")
      .then(snapshot => {
        const { category_id, ...rest } = expense;
        return Promise.all(
          snapshot.val() && snapshot.val().splitwise_id
            ? [
                sw
                  .updateExpense({ id: snapshot.val().splitwise_id, ...rest })
                  .then(res => res[0]),
                ref.child(pending_transaction_id).remove()
              ]
            : [sw.createExpense(expense)]
        );
      });
  }
  return Promise.all([sw.createExpense(expense)]);
};

const sanitizeString = string =>
  string
    .replace("TST* ", "")
    .split(" ")
    .map(w => w[0].toUpperCase() + w.substr(1).toLowerCase())
    .join(" ");
