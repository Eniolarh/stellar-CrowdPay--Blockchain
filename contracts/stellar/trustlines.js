/**
 * trustlines.js
 *
 * Utility to establish, inspect, and remove Stellar asset trustlines.
 * Trustlines must exist before an account can receive a non-native asset.
 *
 * Usage:
 *   node contracts/stellar/trustlines.js --add <accountSecret> <assetCode> <issuerPublicKey> [limit]
 *   node contracts/stellar/trustlines.js --remove <accountSecret> <assetCode> <issuerPublicKey>
 *   node contracts/stellar/trustlines.js --check <accountPublicKey> <assetCode> [issuerPublicKey]
 */

require('dotenv').config({ path: '../../backend/.env' });

const { Keypair, TransactionBuilder, Operation, Asset, Networks, BASE_FEE, Horizon } = require('@stellar/stellar-sdk');

// Authoritative value lives in backend/src/config/constants.js TX_TIMEOUT_CONTRIBUTION_S
const TX_TIMEOUT_CONTRIBUTION_S = 30;

const server = new Horizon.Server(
  process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
);
const networkPassphrase = Networks.TESTNET;

async function addTrustline(accountSecret, assetCode, issuerPublicKey, limit) {
  const keypair = Keypair.fromSecret(accountSecret);
  const account = await server.loadAccount(keypair.publicKey());
  const asset = new Asset(assetCode, issuerPublicKey);

  const opOptions = { asset };
  if (limit !== undefined) {
    opOptions.limit = String(limit);
  }

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.changeTrust(opOptions))
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  tx.sign(keypair);
  const result = await server.submitTransaction(tx);
  console.log(`Trustline established for ${assetCode}:${issuerPublicKey}${limit ? ` with limit ${limit}` : ''}`);
  console.log('Tx hash:', result.hash);
}

async function removeTrustline(accountSecret, assetCode, issuerPublicKey) {
  return addTrustline(accountSecret, assetCode, issuerPublicKey, '0');
}

async function checkTrustline(publicKey, assetCode, issuerPublicKey) {
  const account = await server.loadAccount(publicKey);

  let trusted;
  if (assetCode === 'XLM' || (!issuerPublicKey && assetCode === 'native')) {
    trusted = account.balances.find((b) => b.asset_type === 'native');
    if (trusted) {
      console.log(`Native XLM balance found: ${trusted.balance}`);
      return true;
    }
  } else {
    trusted = account.balances.find((b) => {
      if (b.asset_code !== assetCode) return false;
      if (issuerPublicKey && b.asset_issuer !== issuerPublicKey) return false;
      return true;
    });
  }

  if (trusted) {
    console.log(`${assetCode}${issuerPublicKey ? `:${issuerPublicKey}` : ''} trustline found. Balance: ${trusted.balance}`);
    return true;
  } else {
    console.log(`No trustline for ${assetCode}${issuerPublicKey ? `:${issuerPublicKey}` : ''} on this account.`);
    return false;
  }
}

const [,, flag, ...args] = process.argv;

if (flag === '--add') addTrustline(args[0], args[1], args[2], args[3]).catch(console.error);
else if (flag === '--remove') removeTrustline(args[0], args[1], args[2]).catch(console.error);
else if (flag === '--check') checkTrustline(args[0], args[1], args[2]).catch(console.error);
else {
  console.log('Usage:');
  console.log('  node trustlines.js --add <accountSecret> <assetCode> <issuerPublicKey> [limit]');
  console.log('  node trustlines.js --remove <accountSecret> <assetCode> <issuerPublicKey>');
  console.log('  node trustlines.js --check <accountPublicKey> <assetCode> [issuerPublicKey]');
}
