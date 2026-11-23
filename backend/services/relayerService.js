import {
  Keypair,
  TransactionBuilder,
  Transaction,
  FeeBumpTransaction,
  Networks,
  Operation,
} from '@stellar/stellar-sdk';
import { createClient } from 'redis';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon.stellar.org';
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || Networks.PUBLIC;
const MIN_SIGNER_BALANCE = Number(process.env.RELAYER_MIN_SIGNER_BALANCE || '2');
const BASE_FEE = Number(process.env.RELAYER_BASE_FEE || '100');
const RATE_LIMIT_MAX = Number(process.env.RELAYER_RATE_LIMIT_MAX || '10');
const RATE_LIMIT_WINDOW_SECONDS = Number(process.env.RELAYER_RATE_LIMIT_WINDOW || '3600');

export const ALLOWED_OPERATIONS = ['invoke_host_function'];

export class RelayerError extends Error {
  constructor(code, message, meta = {}) {
    super(message || code);
    this.name = 'RelayerError';
    this.code = code;
    Object.assign(this, meta);
  }
}

RelayerError.OperationNotAllowed = 'OperationNotAllowed';
RelayerError.PoolExhausted = 'PoolExhausted';
RelayerError.RateLimited = 'RELAY_RATE_EXCEEDED';
RelayerError.InvalidTransaction = 'InvalidTransaction';

let redisClient = null;
let redisClientPromise = null;

async function getRedis() {
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }
  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
      client.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.error('[relayerService] redis error', err);
      });
      await client.connect();
      redisClient = client;
      return client;
    })();
  }
  return redisClientPromise;
}

function parseSignerSecrets() {
  const raw = process.env.RELAYER_SIGNER_SECRETS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((secret) => {
      try {
        return Keypair.fromSecret(secret);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[relayerService] invalid signer secret skipped', err.message);
        return null;
      }
    })
    .filter(Boolean);
}

let signerPoolCache = null;

function getSignerPool() {
  if (!signerPoolCache) {
    signerPoolCache = parseSignerSecrets();
  }
  return signerPoolCache;
}

function operationType(op) {
  if (!op) return 'unknown';
  if (op.type) return op.type;
  if (op.body && op.body.type) return op.body.type;
  return 'unknown';
}

function extractOperations(tx) {
  if (tx instanceof FeeBumpTransaction) {
    return extractOperations(tx.innerTransaction);
  }
  if (tx && Array.isArray(tx.operations)) {
    return tx.operations;
  }
  return [];
}

async function fetchAccountBalance(address) {
  const res = await fetch(`${HORIZON_URL}/accounts/${address}`);
  if (!res.ok) {
    if (res.status === 404) return 0;
    throw new RelayerError(
      RelayerError.PoolExhausted,
      `Failed to fetch account ${address}: ${res.status}`,
    );
  }
  const data = await res.json();
  const native = (data.balances || []).find((b) => b.asset_type === 'native');
  return native ? Number(native.balance) : 0;
}

export async function pickSigner() {
  const pool = getSignerPool();
  if (pool.length === 0) {
    throw new RelayerError(RelayerError.PoolExhausted, 'No signers configured');
  }

  const redis = await getRedis();

  const candidates = [];
  for (const keypair of pool) {
    const address = keypair.publicKey();
    const lastUsedRaw = await redis.get(`relayer:signer:${address}:last_used`);
    const lastUsed = lastUsedRaw ? Number(lastUsedRaw) : 0;
    candidates.push({ keypair, address, lastUsed });
  }

  // LRU ordering: oldest last_used first (0 = never used).
  candidates.sort((a, b) => a.lastUsed - b.lastUsed);

  for (const candidate of candidates) {
    let balance;
    try {
      balance = await fetchAccountBalance(candidate.address);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[relayerService] balance check failed', candidate.address, err.message);
      continue;
    }
    if (balance >= MIN_SIGNER_BALANCE) {
      await redis.set(
        `relayer:signer:${candidate.address}:last_used`,
        String(Date.now()),
      );
      return candidate.keypair;
    }
  }

  throw new RelayerError(
    RelayerError.PoolExhausted,
    'No signer with sufficient balance available',
  );
}

export async function getPoolStatus() {
  const pool = getSignerPool();
  const redis = await getRedis();

  const signers = [];
  for (const keypair of pool) {
    const address = keypair.publicKey();
    let balance = 0;
    try {
      balance = await fetchAccountBalance(address);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[relayerService] balance check failed', address, err.message);
    }
    const lastUsedRaw = await redis.get(`relayer:signer:${address}:last_used`);
    const lastUsed = lastUsedRaw ? Number(lastUsedRaw) : null;
    signers.push({
      address,
      balance,
      lastUsed,
      available: balance >= MIN_SIGNER_BALANCE,
    });
  }

  const available = signers.filter((s) => s.available).length;
  const balances = signers.map((s) => s.balance);
  const lowestBalance = balances.length > 0 ? Math.min(...balances) : 0;

  return {
    available,
    total: signers.length,
    lowestBalance,
    signers,
  };
}

export async function enforceRateLimit(userAddress) {
  const redis = await getRedis();
  const key = `relayer:rate:${userAddress}`;
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_SECONDS * 1000;

  // Sliding window using a sorted set of timestamps.
  await redis.zRemRangeByScore(key, 0, windowStart);
  const count = await redis.zCard(key);

  if (count >= RATE_LIMIT_MAX) {
    const oldest = await redis.zRange(key, 0, 0, { WITHSCORES: true });
    let retryAfter = RATE_LIMIT_WINDOW_SECONDS;
    if (oldest && oldest.length >= 2) {
      const oldestTs = Number(oldest[1]);
      retryAfter = Math.max(1, Math.ceil((oldestTs + RATE_LIMIT_WINDOW_SECONDS * 1000 - now) / 1000));
    }
    throw new RelayerError(
      RelayerError.RateLimited,
      'Relay rate limit exceeded',
      { retry_after: retryAfter },
    );
  }

  await redis.zAdd(key, [{ score: now, value: `${now}-${Math.random()}` }]);
  await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);

  return {
    remaining: RATE_LIMIT_MAX - count - 1,
    limit: RATE_LIMIT_MAX,
  };
}

export async function sponsorAndSign(unsignedXdr, userAddress) {
  if (!unsignedXdr || typeof unsignedXdr !== 'string') {
    throw new RelayerError(RelayerError.InvalidTransaction, 'unsignedXdr is required');
  }

  let innerTx;
  try {
    innerTx = TransactionBuilder.fromXDR(unsignedXdr, NETWORK_PASSPHRASE);
  } catch (err) {
    throw new RelayerError(
      RelayerError.InvalidTransaction,
      `Unable to parse transaction: ${err.message}`,
    );
  }

  // Reject if already a fee-bump envelope.
  if (innerTx instanceof FeeBumpTransaction) {
    throw new RelayerError(
      RelayerError.InvalidTransaction,
      'Transaction is already a fee-bump envelope',
    );
  }

  const ops = extractOperations(innerTx);
  if (ops.length === 0) {
    throw new RelayerError(RelayerError.InvalidTransaction, 'Transaction has no operations');
  }

  for (const op of ops) {
    const type = operationType(op);
    if (!ALLOWED_OPERATIONS.includes(type)) {
      throw new RelayerError(
        RelayerError.OperationNotAllowed,
        `Operation type not allowed: ${type}`,
        { operationType: type },
      );
    }
  }

  if (userAddress) {
    await enforceRateLimit(userAddress);
  }

  const sponsor = await pickSigner();
  const sponsorAddress = sponsor.publicKey();

  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    sponsor,
    String(BASE_FEE),
    innerTx,
    NETWORK_PASSPHRASE,
  );
  feeBump.sign(sponsor);

  const signedTxXdr = feeBump.toXDR();
  const fee = Number(feeBump.fee);

  return {
    signedTxXdr,
    fee,
    signerAddress: sponsorAddress,
  };
}

export async function logRelay({ userAddress, txHash, operationType: opType, signerAddress, fee }) {
  return prisma.relayedTransaction.create({
    data: {
      userAddress,
      txHash,
      operationType: opType,
      signerAddress,
      fee: Number(fee),
    },
  });
}

// Backward-compatible factory export.
export function createRelayer(_opts) {
  return {
    sponsorAndSign,
    getPoolStatus,
    pickSigner,
    logRelay,
    enforceRateLimit,
    submit: async (unsignedXdr, userAddress) => sponsorAndSign(unsignedXdr, userAddress),
  };
}

export default {
  RelayerError,
  ALLOWED_OPERATIONS,
  sponsorAndSign,
  getPoolStatus,
  pickSigner,
  logRelay,
  enforceRateLimit,
  createRelayer,
};