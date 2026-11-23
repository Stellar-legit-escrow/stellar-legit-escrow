/**
 * Swagger UI setup for the Stellar Trust Escrow API.
 *
 * Mounts:
 *   GET /api/docs       — Swagger UI (interactive)
 *   GET /api/docs/json  — Raw OpenAPI JSON spec
 */

import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { swaggerOptions } from './swaggerConfig.js';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve api glob relative to the backend root (two levels up from this file)
const backendRoot = path.resolve(__dirname, '..', '..');

// Component schemas referenced by the relayer documentation. These are merged
// into the base spec so that `$ref: '#/components/schemas/RelayerError'` (and
// friends) resolve even when the relayer path file is the only place that
// documents them.
const relayerSchemas = {
  RelayerError: {
    type: 'object',
    description: 'Error envelope returned by the relayer endpoints.',
    properties: {
      code: {
        type: 'string',
        description: 'Machine-readable error code.',
        enum: [
          'OPERATION_NOT_ALLOWED',
          'POOL_EXHAUSTED',
          'RELAY_RATE_EXCEEDED',
          'INVALID_XDR',
          'UNAUTHORIZED',
        ],
      },
      message: { type: 'string', description: 'Human-readable error message.' },
      retry_after: {
        type: 'integer',
        description:
          'Seconds until the client may retry (only present for RELAY_RATE_EXCEEDED).',
      },
    },
    required: ['code', 'message'],
  },
  RelayerSponsorRequest: {
    type: 'object',
    properties: {
      unsignedTxXdr: {
        type: 'string',
        description: 'Base64-encoded unsigned transaction envelope XDR.',
      },
    },
    required: ['unsignedTxXdr'],
  },
  RelayerSponsorResponse: {
    type: 'object',
    properties: {
      signedTxXdr: {
        type: 'string',
        description:
          'Base64-encoded fee-bump envelope XDR, signed by the sponsor. The client must still submit it via stellarService.submitTransaction.',
      },
      fee: { type: 'integer', description: 'Fee (in stroops) paid by the sponsor.' },
      signerAddress: {
        type: 'string',
        description: 'Stellar address of the fee-sponsoring signer.',
      },
    },
    required: ['signedTxXdr', 'fee', 'signerAddress'],
  },
};

const resolvedOptions = {
  ...swaggerOptions,
  apis: [
    path.join(backendRoot, 'api', 'routes', '*.js'),
    path.join(backendRoot, 'api', 'docs', 'paths', '*.js'),
  ],
  definition: {
    ...swaggerOptions.definition,
    components: {
      ...(swaggerOptions.definition?.components ?? {}),
      schemas: {
        ...(swaggerOptions.definition?.components?.schemas ?? {}),
        ...relayerSchemas,
      },
    },
  },
};

const swaggerSpec = swaggerJsdoc(resolvedOptions);

/**
 * Attach Swagger UI and JSON spec endpoints to an Express app.
 * @param {import('express').Application} app
 */
export function setupSwagger(app) {
  // Serve raw OpenAPI JSON spec
  app.get('/api/docs/json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });

  // Serve interactive Swagger UI
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customSiteTitle: 'Stellar Trust Escrow API Docs',
      customCss: '.swagger-ui .topbar { background-color: #1a1a2e; }',
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        filter: true,
        tryItOutEnabled: true,
      },
    }),
  );

  console.log('[Swagger] API docs available at /api/docs');
}

export { swaggerSpec };
