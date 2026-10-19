/**
 * pathPayment.js
 *
 * Demonstrates and tests Stellar path payments.
 * A path payment lets a contributor send XLM while the campaign receives USDC.
 * Stellar's DEX finds the conversion path automatically.
 *
 * Usage:
 *   node contracts/stellar/pathPayment.js --quote <sendAsset> <destAmount> <destAsset> [slippageTolerance]
 *   node contracts/stellar/pathPayment.js --send <senderSecret> <destPublicKey> <sendAsset> <sendMax> <destAmount>
 */

require('dotenv').config({ path: '../../backend/.env' });

const {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  Networks,
  BASE_FEE,
  Horizon,
} = require('@stellar/stellar-sdk');

// Authoritative value lives in backend/src/config/constants.js TX_TIMEOUT_CONTRIBUTION_S
const TX_TIMEOUT_CONTRIBUTION_S = 30;

const server = new Horizon.Server(
  process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
);
const networkPassphrase = Networks.TESTNET;
const USDC = new Asset('USDC', process.env.USDC_ISSUER);

function resolveAsset(code) {
  if (code === 'XLM') return Asset.native();
  if (code === 'USDC') return USDC;
  throw new Error(`Unknown asset: ${code}`);
}

/**
 * Find the best path and estimate how much send asset is needed
 * to receive a given amount of the destination asset.
 */
async function quotePath(sendAssetCode, destAmount, destAssetCode, slippageTolerance = 0.01) {
  const sendAsset = resolveAsset(sendAssetCode);
  const destAsset = resolveAsset(destAssetCode);

  // Use Stellar's path finding endpoint: third argument is destination amount to receive
  const paths = await server
    .strictReceivePaths(sendAsset, destAsset, String(destAmount))
    .call();

  if (!paths.records.length) {
    console.log('No path found. The DEX may not have liquidity for this pair on testnet.');
    return;
  }

  const tolerance = parseFloat(slippageTolerance) || 0.01;
  console.log(`Paths to receive ${destAmount} ${destAssetCode} by sending ${sendAssetCode} (slippage tolerance: ${tolerance * 100}%):`);
  for (const p of paths.records) {
    const srcAmt = parseFloat(p.source_amount);
    const sendMax = (srcAmt * (1 + tolerance)).toFixed(7);
    console.log(`  Estimated source: ${p.source_amount} ${sendAssetCode}`);
    console.log(`  Recommended sendMax: ${sendMax} ${sendAssetCode}`);
    console.log(`  Path: ${p.path.map((a) => a.asset_code || 'XLM').join(' → ') || 'direct'}`);
    console.log();
  }
}

/**
 * Execute a path payment.
 * destAmount is exact — the campaign always receives what it expects.
 * sendMax is the max the sender is willing to pay (slippage protection).
 */
async function sendPathPayment(senderSecret, destPublicKey, sendAssetCode, sendMax, destAmount) {
  const senderKeypair = Keypair.fromSecret(senderSecret);
  const senderAccount = await server.loadAccount(senderKeypair.publicKey());
  const sendAsset = resolveAsset(sendAssetCode);

  // Validate quote before sending if possible
  try {
    const paths = await server.strictReceivePaths(sendAsset, USDC, String(destAmount)).call();
    if (paths.records.length > 0) {
      const best = parseFloat(paths.records[0].source_amount);
      if (parseFloat(sendMax) < best) {
        throw new Error(`sendMax (${sendMax}) is lower than the best quoted source amount (${best})`);
      }
    }
  } catch (err) {
    if (err.message.includes('sendMax')) throw err;
  }

  const tx = new TransactionBuilder(senderAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset,
        sendMax: String(sendMax),
        destination: destPublicKey,
        destAsset: USDC,
        destAmount: String(destAmount),
        path: [], // let Stellar discover the path
      })
    )
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  tx.sign(senderKeypair);
  const result = await server.submitTransaction(tx);
  console.log('Path payment submitted.');
  console.log('Tx hash:', result.hash);
}

const [,, flag, ...args] = process.argv;

if (flag === '--quote') quotePath(args[0], args[1], args[2], args[3]).catch(console.error);
else if (flag === '--send') sendPathPayment(args[0], args[1], args[2], args[3], args[4]).catch(console.error);
else {
  console.log('Usage:');
  console.log('  node pathPayment.js --quote <sendAsset> <destAmount> <destAsset> [slippageTolerance]');
  console.log('  node pathPayment.js --send <senderSecret> <destPublicKey> <sendAsset> <sendMax> <destAmount>');
}
