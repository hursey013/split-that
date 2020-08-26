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

exports.events = functions.https.onRequest((request, response) => {
  functions.logger.info(request.body);

  if (request.body.webhook_code === "DEFAULT_UPDATE") {
    const startDate = moment()
      .subtract(30, "days")
      .format("YYYY-MM-DD");
    const endDate = moment().format("YYYY-MM-DD");

    plaidClient
      .getTransactions(functions.config().plaid.token, startDate, endDate, {
        account_ids: functions.config().plaid.account_ids.split(" ")
      })
      .then(res =>
        res.transactions
          .filter(transaction => !transaction.pending)
          .forEach(transaction =>
            ref
              .child(transaction.transaction_id)
              .once("value")
              .then(
                snapshot =>
                  !snapshot.exists() &&
                  ref
                    .child(transaction.transaction_id)
                    .set(transaction)
                    .then(() =>
                      sw.createExpense({
                        users: [
                          {
                            user_id: functions.config().splitwise.user1_id,
                            paid_share: transaction.amount,
                            owed_share:
                              transaction.amount *
                              Number(functions.config().splitwise.user1_share)
                          },
                          {
                            user_id: functions.config().splitwise.user2_id,
                            owed_share:
                              transaction.amount *
                              Number(functions.config().splitwise.user2_share)
                          }
                        ],
                        cost: transaction.amount,
                        description: transaction.merchant_name,
                        group_id: functions.config().splitwise.group_id
                      })
                    )
                    .then(res =>
                      functions.logger.info(
                        `Added: ${transaction.transaction_id}`
                      )
                    )
              )
          )
      )
      .catch(err => {
        if (err !== null) {
          if (err instanceof plaid.PlaidError) {
            functions.logger.error(err.error_code + ": " + err.error_message);
          } else {
            functions.logger.error(err.toString());
          }
        }
      });
  }

  response.sendStatus(200);
});
