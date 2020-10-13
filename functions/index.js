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
      // Fetch transactions from the last 30 days
      .getTransactions(functions.config().plaid.token, startDate, endDate, {
        account_ids: functions.config().plaid.account_ids.split(" ")
      })
      .then(res =>
        res.transactions
          // Filter out transactions that are pending and/or less than $10
          .filter(
            transaction => !transaction.pending && transaction.amount >= 10
          )
          .forEach(processTransaction)
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
  }

  response.sendStatus(200);
});

const processTransaction = transaction =>
  ref
    .child(transaction.transaction_id)
    .once("value")
    .then(snapshot => {
      // Filter out existing transactions
      if (!snapshot.exists()) {
        functions.logger.info(JSON.stringify(transaction, null, 2));

        return createExpense(transaction).then(({ id }) =>
          ref
            .child(transaction.transaction_id)
            .set({ ...transaction, splitwise_id: id })
        );
      }
      return false;
    })
    .catch(err => {
      if (err !== null) {
        functions.logger.error(err.toString());
      }
    });

const createExpense = transaction =>
  sw.createExpense({
    users: [
      {
        user_id: functions.config().splitwise.user1_id,
        paid_share: transaction.amount,
        owed_share:
          transaction.amount * Number(functions.config().splitwise.user1_share)
      },
      {
        user_id: functions.config().splitwise.user2_id,
        owed_share:
          transaction.amount * Number(functions.config().splitwise.user2_share)
      }
    ],
    cost: transaction.amount,
    description: toTitleCase(transaction.merchant_name || transaction.name),
    group_id: functions.config().splitwise.group_id,
    category_id: categoryTable[transaction.category_id] || null
  });

const toTitleCase = string =>
  string
    .replace("TST* ", "")
    .split(" ")
    .map(w => w[0].toUpperCase() + w.substr(1).toLowerCase())
    .join(" ");
