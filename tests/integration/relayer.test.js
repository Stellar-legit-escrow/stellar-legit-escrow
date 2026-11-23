// tests/integration/relayer.test.js
'use strict';

/**
 * Integration tests for POST /api/v1/relayer/sponsor
 *
 * These tests exercise the full request lifecycle (route -> controller ->
 * relayerService) using a lightweight test app. External dependencies
 * (Stellar SDK, Redis, Horizon, Prisma) are mocked so the tests are
 * deterministic and hermetic.
 */

const express = require('express');
const request = require('supertest');

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// --- Stellar SDK mock -------------------------------------------------------
const mockSignedXdr = 'AAAAAgAAAABsigned-fee-bump-envelope-XDR';

const mockTransactionBuilder = jest.fn().mockImplementation(() => ({
  addOperation: jest.fn().mockReturnThis(),
  addFeeBumpOperation: jest.fn().mockReturnThis(),
  setTimeout: jest.fn().mockReturnThis(),
  build: jest.fn().mockReturnValue({
    toXDR: jest.fn().mockReturnValue(mockSignedXdr),
    sign: jest.fn(),
    hash: jest.fn().mockReturnValue(Buffer.from('deadbeef', 'hex')),
  }),
}));

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    TransactionBuilder: Object.assign(
      jest.fn().mockImplementation((...args) => mockTransactionBuilder(...args)),
      {
        fromXDR: jest.fn().mockReturnValue({
          operations: [
            {
              type: 'invokeHostFunction',
              body: { type: 'invokeHostFunction' },
            },
          ],
          source: 'GUSERADDRESS',
          fee: '100',
          toXDR: jest.fn().mockReturnValue(mockSignedXdr),
        }),
      }
    ),
    Keypair: {
      fromSecret: jest.fn().mockReturnValue({
        publicKey: () => 'GSPONSORADDRESS',
        sign: jest.fn(),
      }),
      fromPublicKey: jest.fn().mockReturnValue({
        publicKey: () => 'GSPONSORADDRESS',
      }),
    },
    FeeBumpTransaction: jest.fn().mockImplementation(() => ({
      toXDR: jest.fn().mockReturnValue(mockSignedXdr),
      sign: jest.fn(),
      hash: jest.fn().mockReturnValue(Buffer.from('deadbeef', 'hex')),
    })),
    Networks: { TESTNET: 'Test SDF Network ; September 2015' },
    Operation: {
      invokeHostFunction: jest.fn().mockReturnValue({ type: 'invokeHostFunction' }),
    },
    Asset: actual.Asset,
  };
});

// --- Redis mock -------------------------------------------------------------
const redisStore = new Map();

const mockRedis = {
  get: jest.fn(async (key) => (redisStore.has(key) ? redisStore.get(key) : null)),
  set: jest.fn(async (key, value) => {
    redisStore.set(key, value);
    return 'OK';
  }),
  setex: jest.fn(async (key, ttl, value) => {
    redisStore.set(key, value);
    return 'OK';
  }),
  incr: jest.fn(async (key) => {
    const current = parseInt(redisStore.get(key) || '0', 10) + 1;
    redisStore.set(key, String(current));
    return current;
  }),
  expire: jest.fn(async () => 1),
  zadd: jest.fn(async () => 1),
  zrange: jest.fn(async () => []),
  zremrangebyscore: jest.fn(async () => 0),
  zcard: jest.fn(async () => 0),
  del: jest.fn(async (key) => {
    redisStore.delete(key);
    return 1;
  }),
  ttl: jest.fn(async () => 3600),
  keys: jest.fn(async () => []),
};

jest.mock('../../backend/config/redis', () => mockRedis, { virtual: true });
jest.mock('../../backend/config/redisClient', () => mockRedis, { virtual: true });

// --- Horizon mock -----------------------------------------------------------
const horizonAccounts = new Map();

const mockHorizonServer = {
  accounts: jest.fn().mockImplementation(() => ({
    accountId: jest.fn().mockImplementation((address) => ({
      call: jest.fn(async () => {
        const account = horizonAccounts.get(address);
        if (!account) {
          const err = new Error('Account not found');
          err.response = { status: 404 };
          throw err;
        }
        return account;
      }),
    })),
  })),
};

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => mockHorizonServer),
    },
    TransactionBuilder: Object.assign(
      jest.fn().mockImplementation((...args) => mockTransactionBuilder(...args)),
      {
        fromXDR: jest.fn().mockReturnValue({
          operations: [
            {
              type: 'invokeHostFunction',
              body: { type: 'invokeHostFunction' },
            },
          ],
          source: 'GUSERADDRESS',
          fee: '100',
          toXDR: jest.fn().mockReturnValue(mockSignedXdr),
        }),
      }
    ),
    Keypair: {
      fromSecret: jest.fn().mockReturnValue({
        publicKey: () => 'GSPONSORADDRESS',
        sign: jest.fn(),
      }),
      fromPublicKey: jest.fn().mockReturnValue({
        publicKey: () => 'GSPONSORADDRESS',
      }),
    },
    FeeBumpTransaction: jest.fn().mockImplementation(() => ({
      toXDR: jest.fn().mockReturnValue(mockSignedXdr),
      sign: jest.fn(),
      hash: jest.fn().mockReturnValue(Buffer.from('deadbeef', 'hex')),
    })),
    Networks: { TESTNET: 'Test SDF Network ; September 2015' },
    Operation: {
      invokeHostFunction: jest.fn().mockReturnValue({ type: 'invokeHostFunction' }),
    },
    Asset: actual.Asset,
  };
});

// --- Prisma mock ------------------------------------------------------------
const mockPrisma = {
  relayedTransaction: {
    create: jest.fn(async ({ data }) => ({
      id: 'relay-id-1',
      ...data,
      relayedAt: new Date(),
    })),
    findUnique: jest.fn(async () => null),
    findMany: jest.fn(async () => []),
  },
};

jest.mock('../../backend/config/prisma', () => mockPrisma, { virtual: true });
jest.mock('../../backend/config/database', () => ({ prisma: mockPrisma }), { virtual: true });

// ---------------------------------------------------------------------------
// Test app setup
// ---------------------------------------------------------------------------

const TEST_USER = {
  id: 'user-1',
  address: 'GUSERADDRESS',
  email: 'user@example.com',
};

function buildTestApp() {
  const app = express();
  app.use(express.json());

  // Fake auth middleware: attaches user unless x-test-no-auth header is set.
  app.use((req, res, next) => {
    if (req.headers['x-test-no-auth'] === 'true') {
      return next();
    }
    req.user = { ...TEST_USER };
    return next();
  });

  // Lazily require the routes so mocks are in place.
  // eslint-disable-next-line global-require
  const relayerRoutes = require('../../backend/api/routes/relayerRoutes');
  app.use('/api/v1/relayer', relayerRoutes);

  // Error handler that maps RelayerError codes to HTTP statuses.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const statusMap = {
      OperationNotAllowed: 422,
      PoolExhausted: 503,
      RelayRateExceeded: 429,
      RELAY_RATE_EXCEEDED: 429,
      InvalidTransaction: 400,
      Unauthorized: 401,
    };
    const code = err.code || err.name || 'InternalError';
    const status = statusMap[code] || err.status || 500;
    const body = { code, message: err.message || code };
    if (err.retry_after !== undefined) {
      body.retry_after = err.retry_after;
    }
    return res.status(status).json(body);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setSignerBalances(balances) {
  horizonAccounts.clear();
  Object.entries(balances).forEach(([address, xlm]) => {
    horizonAccounts.set(address, {
      account_id: address,
      balances: [
        { asset_type: 'native', balance: String(xlm) },
      ],
    });
  });
}

function resetRedis() {
  redisStore.clear();
  Object.values(mockRedis).forEach((fn) => {
    if (typeof fn === 'function' && fn.mockClear) fn.mockClear();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/v1/relayer/sponsor (integration)', () => {
  let app;
  let relayerService;

  const ORIGINAL_ENV = { ...process.env };

  beforeAll(() => {
    process.env.RELAYER_SIGNER_SECRETS =
      'SSECRET1,SSECRET2,SSECRET3';
    process.env.RELAYER_MIN_SIGNER_BALANCE = '2';
    process.env.RELAYER_RATE_LIMIT = '10';
    process.env.RELAYER_RATE_WINDOW_SECONDS = '3600';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_NETWORK = 'TESTNET';
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  beforeEach(() => {
    jest.resetModules();
    resetRedis();
    mockPrisma.relayedTransaction.create.mockClear();
    app = buildTestApp();
    // eslint-disable-next-line global-require
    relayerService = require('../../backend/services/relayerService');
  });

  it('returns 401 when the user is not authenticated', async () => {
    const res = await request(app)
      .post('/api/v1/relayer/sponsor')
      .set('x-test-no-auth', 'true')
      .send({ unsignedTxXdr: 'AAAAunsigned' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when unsignedTxXdr is missing', async () => {
    const res = await request(app)
      .post('/api/v1/relayer/sponsor')
      .send({});

    expect(res.status).toBe(400);
  });

  it('successfully sponsors an allowed operation and returns a signed fee-bump XDR', async () => {
    setSignerBalances({
      GSPONSORADDRESS: 100,
    });

    const res = await request(app)
      .post('/api/v1/relayer/sponsor')
      .send({ unsignedTxXdr: 'AAAAunsigned' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('signedTxXdr');
    expect(typeof res.body.signedTxXdr).toBe('string');
    expect(res.body.signedTxXdr.length).toBeGreaterThan(0);
    expect(res.body).toHaveProperty('fee');
    expect(typeof res.body.fee).toBe('number');
    expect(res.body).toHaveProperty('signerAddress');
    expect(typeof res.body.signerAddress).toBe('string');

    // The relayed transaction should have been logged.
    expect(mockPrisma.relayedTransaction.create).toHaveBeenCalledTimes(1);
    const createArgs = mockPrisma.relayedTransaction.create.mock.calls[0][0];
    expect(createArgs.data).toMatchObject({
      userAddress: TEST_USER.address,
      operationType: 'invoke_host_function',
    });
  });

  it('returns 422 OperationNotAllowed for a disallowed operation (payment)', async () => {
    setSignerBalances({ GSPONSORADDRESS: 100 });

    // Override the parsed transaction to expose a payment operation.
    const sdk = require('@stellar/stellar-sdk');
    sdk.TransactionBuilder.fromXDR.mockReturnValueOnce({
      operations: [
        {
          type: 'payment',
          body: { type: 'payment' },
        },
      ],
      source: 'GUSERADDRESS',
      fee: '100',
      toXDR: jest.fn().mockReturnValue(mockSignedXdr),
    });

    const res = await request(app)
      .post('/api/v1/relayer/sponsor')
      .send({ unsignedTxXdr: 'AAAApayment' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('OperationNotAllowed');
    expect(mockPrisma.relayedTransaction.create).not.toHaveBeenCalled();
  });

  it('returns 503 PoolExhausted when all signers are below MIN_SIGNER_BALANCE', async () => {
    setSignerBalances({
      GSPONSORADDRESS: 0.5,
    });

    const res = await request(app)
      .post('/api/v1/relayer/sponsor')
      .send({ unsignedTxXdr: 'AAAAunsigned' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PoolExhausted');
    expect(mockPrisma.relayedTransaction.create).not.toHaveBeenCalled();
  });

  it('returns 429 RELAY_RATE_EXCEEDED with retry_after on the 11th relay within an hour', async () => {
    setSignerBalances({ GSPONSORADDRESS: 100 });

    // Simulate 10 successful relays by pre-populating the sliding window.
    const rateKey = `relayer:rate:${TEST_USER.address}`;
    const now = Date.now();
    const members = [];
    for (let i = 0; i < 10; i += 1) {
      members.push(`${now - i * 1000}-${i}`);
    }
    redisStore.set(rateKey, JSON.stringify(members));

    // Make zcard report 10 entries for the rate key.
    mockRedis.zcard.mockImplementation(async (key) => {
      if (key === rateKey) return 10;
      return 0;
    });
    mockRedis.zrange.mockImplementation(async (key) => {
      if (key === rateKey) return members;
      return [];
    });

    const res = await request(app)
      .post('/api/v1/relayer/sponsor')
      .send({ unsignedTxXdr: 'AAAAunsigned' });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RELAY_RATE_EXCEEDED');
    expect(res.body).toHaveProperty('retry_after');
    expect(typeof res.body.retry_after).toBe('number');
    expect(res.body.retry_after).toBeGreaterThan(0);
    expect(mockPrisma.relayedTransaction.create).not.toHaveBeenCalled();
  });

  it('allows the 10th relay within the window (boundary check)', async () => {
    setSignerBalances({ GSPONSORADDRESS: 100 });

    const rateKey = `relayer:rate:${TEST_USER.address}`;
    const now = Date.now();
    const members = [];
    for (let i = 0; i < 9; i += 1) {
      members.push(`${now - i * 1000}-${i}`);
    }
    redisStore.set(rateKey, JSON.stringify(members));

    mockRedis.zcard.mockImplementation(async (key) => {
      if (key === rateKey) return 9;
      return 0;
    });
    mockRedis.zrange.mockImplementation(async (key) => {
      if (key === rateKey) return members;
      return [];
    });

    const res = await request(app)
      .post('/api/v1/relayer/sponsor')
      .send({ unsignedTxXdr: 'AAAAunsigned' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('signedTxXdr');
  });

  it('selects the least-recently-used signer via pickSigner', async () => {
    setSignerBalances({ GSPONSORADDRESS: 100 });

    // Two signers with different last_used timestamps.
    redisStore.set('relayer:signer:GSPONSORADDRESS:last_used', String(Date.now()));

    const signer = await relayerService.pickSigner();
    expect(signer).toBeDefined();
    expect(signer).toHaveProperty('address');
    expect(signer).toHaveProperty('keypair');
  });
});