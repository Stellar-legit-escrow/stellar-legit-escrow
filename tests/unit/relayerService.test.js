// tests/unit/relayerService.test.js
'use strict';

/**
 * Unit tests for backend/services/relayerService.js
 *
 * Covers:
 *  - ALLOWED_OPERATIONS whitelist (rejects non invoke_host_function ops)
 *  - pickSigner LRU selection via mocked Redis last_used timestamps
 *  - PoolExhausted when all Horizon balances < MIN_SIGNER_BALANCE
 *  - sponsorAndSign producing a valid fee-bump XDR signed by the sponsor
 *  - Sliding-window rate limiter: 10 allowed, 11th rejected with retry_after
 *
 * Stellar SDK, Redis and Prisma are all mocked.
 */

// ---------------------------------------------------------------------------
// Mocks (must be declared before requiring the module under test)
// ---------------------------------------------------------------------------

// --- Stellar SDK mock -------------------------------------------------------
const mockFeeBumpTx = {
  toXDR: jest.fn(() => 'SIGNED_FEE_BUMP_XDR'),
  sign: jest.fn(),
  fee: '100',
};

const mockTransactionBuilder = jest.fn().mockImplementation(() => ({
  addFeeBumpOperation: jest.fn().mockReturnThis(),
  addOperation: jest.fn().mockReturnThis(),
  setTimeout: jest.fn().mockReturnThis(),
  build: jest.fn(() => mockFeeBumpTx),
}));

const mockTransactionBuilderFromXDR = jest.fn(() => ({
  build: jest.fn(() => mockFeeBumpTx),
}));

const mockKeypairFromSecret = jest.fn((secret) => ({
  secret: () => secret,
  publicKey: () => `G${secret.slice(1, 10).toUpperCase()}`,
  sign: jest.fn(),
}));

const mockTransaction = {
  operations: [
    {
      type: 'invokeHostFunction',
      type_i: 24,
    },
  ],
};

const mockTransactionBuilderFromXDRInstance = {
  build: jest.fn(() => mockTransaction),
};

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Keypair: {
      fromSecret: (...args) => mockKeypairFromSecret(...args),
    },
    TransactionBuilder: Object.assign(
      jest.fn((...args) => mockTransactionBuilder(...args)),
      {
        fromXDR: (...args) => mockTransactionBuilderFromXDR(...args),
        fromXDRInstance: () => mockTransactionBuilderFromXDRInstance,
      }
    ),
    FeeBumpTransaction: jest.fn().mockImplementation(() => mockFeeBumpTx),
    Networks: { TESTNET: 'Test SDF Network ; September 2015' },
    BASE_FEE: '100',
    Operation: {
      invokeHostFunction: jest.fn(() => ({ type: 'invokeHostFunction' })),
    },
    Asset: actual.Asset,
    Account: jest.fn().mockImplementation((id, seq) => ({ id, sequenceNumber: () => seq })),
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
  del: jest.fn(async (key) => {
    redisStore.delete(key);
    return 1;
  }),
  zadd: jest.fn(async () => 1),
  zremrangebyscore: jest.fn(async () => 0),
  zcard: jest.fn(async () => 0),
  zrange: jest.fn(async () => []),
  expire: jest.fn(async () => 1),
  incr: jest.fn(async (key) => {
    const cur = parseInt(redisStore.get(key) || '0', 10) + 1;
    redisStore.set(key, String(cur));
    return cur;
  }),
  pexpire: jest.fn(async () => 1),
  pttl: jest.fn(async () => 3600000),
  multi: jest.fn(() => mockRedis),
  exec: jest.fn(async () => []),
};

jest.mock('../../backend/config/redis', () => mockRedis, { virtual: true });
jest.mock('../../backend/config/redisClient', () => mockRedis, { virtual: true });
jest.mock('../../backend/lib/redis', () => mockRedis, { virtual: true });
jest.mock('../../backend/utils/redis', () => mockRedis, { virtual: true });

// --- Prisma mock ------------------------------------------------------------
const mockPrisma = {
  relayedTransaction: {
    create: jest.fn(async (args) => ({ id: 'relay_1', ...args.data })),
    findUnique: jest.fn(async () => null),
    count: jest.fn(async () => 0),
  },
};

jest.mock('../../backend/config/prisma', () => mockPrisma, { virtual: true });
jest.mock('../../backend/lib/prisma', () => mockPrisma, { virtual: true });
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => mockPrisma) }), { virtual: true });

// --- Horizon / fetch mock ---------------------------------------------------
const mockFetch = jest.fn();
global.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------
const relayerService = require('../../backend/services/relayerService');

const {
  sponsorAndSign,
  getPoolStatus,
  pickSigner,
  logRelay,
  RelayerError,
  ALLOWED_OPERATIONS,
  MIN_SIGNER_BALANCE,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_SECONDS,
} = relayerService;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SIGNER_SECRETS = [
  'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1',
  'SBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2',
  'SCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3',
];

function horizonAccountResponse(address, balance) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      account_id: address,
      balances: [{ asset_type: 'native', balance: String(balance) }],
    }),
  };
}

function horizonNotFound() {
  return {
    ok: false,
    status: 404,
    json: async () => ({ status: 404 }),
  };
}

function resetAll() {
  redisStore.clear();
  jest.clearAllMocks();

  // Default fetch: every signer has plenty of XLM
  mockFetch.mockImplementation(async (url) => {
    const match = String(url).match(/\/accounts\/([^/?]+)/);
    const address = match ? match[1] : 'unknown';
    return horizonAccountResponse(address, 100);
  });

  // Default redis behaviour
  mockRedis.get.mockImplementation(async (key) =>
    redisStore.has(key) ? redisStore.get(key) : null
  );
  mockRedis.set.mockImplementation(async (key, value) => {
    redisStore.set(key, value);
    return 'OK';
  });
  mockRedis.setex.mockImplementation(async (key, ttl, value) => {
    redisStore.set(key, value);
    return 'OK';
  });
  mockRedis.del.mockImplementation(async (key) => {
    redisStore.delete(key);
    return 1;
  });
  mockRedis.incr.mockImplementation(async (key) => {
    const cur = parseInt(redisStore.get(key) || '0', 10) + 1;
    redisStore.set(key, String(cur));
    return cur;
  });
  mockRedis.pexpire.mockImplementation(async () => 1);
  mockRedis.pttl.mockImplementation(async () => RATE_LIMIT_WINDOW_SECONDS * 1000);
  mockRedis.zadd.mockImplementation(async () => 1);
  mockRedis.zremrangebyscore.mockImplementation(async () => 0);
  mockRedis.zcard.mockImplementation(async () => 0);
  mockRedis.zrange.mockImplementation(async () => []);
  mockRedis.expire.mockImplementation(async () => 1);
  mockRedis.multi.mockImplementation(() => mockRedis);
  mockRedis.exec.mockImplementation(async () => []);

  // Default SDK behaviour
  mockTransactionBuilderFromXDR.mockImplementation(() => ({
    build: jest.fn(() => mockTransaction),
  }));
  mockFeeBumpTx.toXDR.mockReturnValue('SIGNED_FEE_BUMP_XDR');
  mockFeeBumpTx.sign.mockImplementation(() => {});
  mockKeypairFromSecret.mockImplementation((secret) => ({
    secret: () => secret,
    publicKey: () => `G${secret.slice(1, 10).toUpperCase()}`,
    sign: jest.fn(),
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('relayerService', () => {
  beforeEach(() => {
    resetAll();
    if (typeof relayerService.__resetForTests === 'function') {
      relayerService.__resetForTests();
    }
  });

  // -------------------------------------------------------------------------
  describe('ALLOWED_OPERATIONS whitelist', () => {
    it('only allows invoke_host_function', () => {
      expect(ALLOWED_OPERATIONS).toEqual(['invoke_host_function']);
    });

    it('rejects a payment operation with RelayerError.OperationNotAllowed', async () => {
      // Build a transaction whose only operation is a payment
      mockTransactionBuilderFromXDR.mockImplementationOnce(() => ({
        build: jest.fn(() => ({
          operations: [{ type: 'payment', type_i: 1 }],
        })),
      }));

      await expect(
        sponsorAndSign('UNSIGNED_PAYMENT_XDR', 'GUSERADDRESS')
      ).rejects.toMatchObject({
        code: 'OperationNotAllowed',
      });

      await expect(
        sponsorAndSign('UNSIGNED_PAYMENT_XDR', 'GUSERADDRESS')
      ).rejects.toBeInstanceOf(RelayerError);
    });

    it('rejects a create_account operation', async () => {
      mockTransactionBuilderFromXDR.mockImplementationOnce(() => ({
        build: jest.fn(() => ({
          operations: [{ type: 'createAccount', type_i: 0 }],
        })),
      }));

      await expect(
        sponsorAndSign('UNSIGNED_CREATE_ACCOUNT_XDR', 'GUSERADDRESS')
      ).rejects.toMatchObject({ code: 'OperationNotAllowed' });
    });

    it('rejects a transaction with mixed operations when any is disallowed', async () => {
      mockTransactionBuilderFromXDR.mockImplementationOnce(() => ({
        build: jest.fn(() => ({
          operations: [
            { type: 'invokeHostFunction', type_i: 24 },
            { type: 'payment', type_i: 1 },
          ],
        })),
      }));

      await expect(
        sponsorAndSign('UNSIGNED_MIXED_XDR', 'GUSERADDRESS')
      ).rejects.toMatchObject({ code: 'OperationNotAllowed' });
    });
  });

  // -------------------------------------------------------------------------
  describe('pickSigner (LRU)', () => {
    it('selects the signer with the oldest last_used timestamp', async () => {
      // Configure three signers with distinct last_used timestamps
      const signerAddresses = SIGNER_SECRETS.map(
        (s) => `G${s.slice(1, 10).toUpperCase()}`
      );

      // signer[0] used most recently, signer[1] used longest ago, signer[2] middle
      redisStore.set(
        `relayer:signer:${signerAddresses[0]}:last_used`,
        String(Date.now() - 1000)
      );
      redisStore.set(
        `relayer:signer:${signerAddresses[1]}:last_used`,
        String(Date.now() - 100000)
      );
      redisStore.set(
        `relayer:signer:${signerAddresses[2]}:last_used`,
        String(Date.now() - 50000)
      );

      const picked = await pickSigner();

      expect(picked).toBeDefined();
      expect(picked.address).toBe(signerAddresses[1]);
    });

    it('treats a signer with no last_used entry as least-recently-used', async () => {
      const signerAddresses = SIGNER_SECRETS.map(
        (s) => `G${s.slice(1, 10).toUpperCase()}`
      );

      // Only two of three have been used
      redisStore.set(
        `relayer:signer:${signerAddresses[0]}:last_used`,
        String(Date.now() - 1000)
      );
      redisStore.set(
        `relayer:signer:${signerAddresses[1]}:last_used`,
        String(Date.now() - 2000)
      );
      // signerAddresses[2] has no entry -> should be picked

      const picked = await pickSigner();
      expect(picked.address).toBe(signerAddresses[2]);
    });

    it('updates last_used after picking a signer', async () => {
      const signerAddresses = SIGNER_SECRETS.map(
        (s) => `G${s.slice(1, 10).toUpperCase()}`
      );

      const picked = await pickSigner();
      const key = `relayer:signer:${picked.address}:last_used`;

      expect(mockRedis.set).toHaveBeenCalledWith(
        key,
        expect.any(String)
      );
      expect(redisStore.has(key)).toBe(true);
      expect(signerAddresses).toContain(picked.address);
    });
  });

  // -------------------------------------------------------------------------
  describe('PoolExhausted', () => {
    it('throws RelayerError.PoolExhausted when all balances are below MIN_SIGNER_BALANCE', async () => {
      mockFetch.mockImplementation(async (url) => {
        const match = String(url).match(/\/accounts\/([^/?]+)/);
        const address = match ? match[1] : 'unknown';
        // Every signer has less than the minimum
        return horizonAccountResponse(address, MIN_SIGNER_BALANCE - 1);
      });

      await expect(pickSigner()).rejects.toMatchObject({
        code: 'PoolExhausted',
      });

      await expect(pickSigner()).rejects.toBeInstanceOf(RelayerError);
    });

    it('throws PoolExhausted when all accounts are unfunded (404)', async () => {
      mockFetch.mockImplementation(async () => horizonNotFound());

      await expect(pickSigner()).rejects.toMatchObject({
        code: 'PoolExhausted',
      });
    });

    it('succeeds when at least one signer has >= MIN_SIGNER_BALANCE', async () => {
      let call = 0;
      mockFetch.mockImplementation(async (url) => {
        call += 1;
        const match = String(url).match(/\/accounts\/([^/?]+)/);
        const address = match ? match[1] : 'unknown';
        // First signer is underfunded, second is fine
        if (call === 1) {
          return horizonAccountResponse(address, MIN_SIGNER_BALANCE - 1);
        }
        return horizonAccountResponse(address, MIN_SIGNER_BALANCE + 10);
      });

      const picked = await pickSigner();
      expect(picked).toBeDefined();
      expect(picked.address).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('getPoolStatus', () => {
    it('reports available, total and lowestBalance', async () => {
      let call = 0;
      mockFetch.mockImplementation(async (url) => {
        call += 1;
        const match = String(url).match(/\/accounts\/([^/?]+)/);
        const address = match ? match[1] : 'unknown';
        // 2 funded, 1 underfunded
        if (call === 1) return horizonAccountResponse(address, 50);
        if (call === 2) return horizonAccountResponse(address, 5);
        return horizonAccountResponse(address, MIN_SIGNER_BALANCE - 1);
      });

      const status = await getPoolStatus();

      expect(status).toEqual(
        expect.objectContaining({
          available: expect.any(Number),
          total: expect.any(Number),
          lowestBalance: expect.any(Number),
        })
      );
      expect(status.total).toBe(SIGNER_SECRETS.length);
      expect(status.available).toBe(2);
      expect(status.lowestBalance).toBe(MIN_SIGNER_BALANCE - 1);
    });
  });

  // -------------------------------------------------------------------------
  describe('sponsorAndSign', () => {
    it('produces a valid fee-bump XDR signed by the sponsor', async () => {
      const result = await sponsorAndSign('UNSIGNED_INVOKE_XDR', 'GUSERADDRESS');

      expect(result).toEqual(
        expect.objectContaining({
          signedTxXdr: expect.any(String),
          fee: expect.any(Number),
          signerAddress: expect.any(String),
        })
      );
      expect(result.signedTxXdr).toBe('SIGNED_FEE_BUMP_XDR');
      // The sponsor keypair must have been used to sign
      expect(mockFeeBumpTx.sign).toHaveBeenCalled();
    });

    it('accepts invoke_host_function operations', async () => {
      mockTransactionBuilderFromXDR.mockImplementationOnce(() => ({
        build: jest.fn(() => ({
          operations: [{ type: 'invokeHostFunction', type_i: 24 }],
        })),
      }));

      await expect(
        sponsorAndSign('UNSIGNED_INVOKE_XDR', 'GUSERADDRESS')
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('rate limiting (sliding window)', () => {
    it('allows 10 relays within the window', async () => {
      const user = 'GRATELIMITUSER';

      for (let i = 0; i < RATE_LIMIT_MAX; i += 1) {
        await expect(
          sponsorAndSign('UNSIGNED_INVOKE_XDR', user)
        ).resolves.toBeDefined();
      }
    });

    it('rejects the 11th relay with RELAY_RATE_EXCEEDED and retry_after', async () => {
      const user = 'GRATELIMITUSER2';

      for (let i = 0; i < RATE_LIMIT_MAX; i += 1) {
        await sponsorAndSign('UNSIGNED_INVOKE_XDR', user);
      }

      let error;
      try {
        await sponsorAndSign('UNSIGNED_INVOKE_XDR', user);
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(error).toBeInstanceOf(RelayerError);
      expect(error.code).toBe('RELAY_RATE_EXCEEDED');
      expect(error.retryAfter).toEqual(expect.any(Number));
      expect(error.retryAfter).toBeGreaterThan(0);
      expect(error.retryAfter).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_SECONDS);
    });

    it('tracks rate limits per user independently', async () => {
      const userA = 'GUSERA';
      const userB = 'GUSERB';

      for (let i = 0; i < RATE_LIMIT_MAX; i += 1) {
        await sponsorAndSign('UNSIGNED_INVOKE_XDR', userA);
      }

      // userA is now rate-limited
      await expect(
        sponsorAndSign('UNSIGNED_INVOKE_XDR', userA)
      ).rejects.toMatchObject({ code: 'RELAY_RATE_EXCEEDED' });

      // userB should still be allowed
      await expect(
        sponsorAndSign('UNSIGNED_INVOKE_XDR', userB)
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('logRelay', () => {
    it('persists a relayed transaction record', async () => {
      const record = await logRelay({
        userAddress: 'GUSERADDRESS',
        txHash: 'abc123',
        operationType: 'invoke_host_function',
        signerAddress: 'GSIGNER',
        fee: 100,
      });

      expect(mockPrisma.relayedTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userAddress: 'GUSERADDRESS',
          txHash: 'abc123',
          operationType: 'invoke_host_function',
          signerAddress: 'GSIGNER',
          fee: 100,
        }),
      });
      expect(record).toBeDefined();
    });
  });
});