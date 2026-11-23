import relayerService, {
  RelayerError,
  getPoolStatus,
  logRelay,
  sponsorAndSign,
} from '../../services/relayerService.js';
import logger from '../../utils/logger.js';
import { errorsTotal } from '../../utils/metrics.js';

/**
 * Map a RelayerError (or generic error) to an HTTP status code and body.
 */
function mapRelayerError(error) {
  const code = error?.code || error?.name;

  switch (code) {
    case RelayerError.OperationNotAllowed:
      return {
        status: 422,
        body: {
          error: RelayerError.OperationNotAllowed,
          message: error.message || 'Operation type is not allowed for relay',
        },
      };
    case RelayerError.PoolExhausted:
      return {
        status: 503,
        body: {
          error: RelayerError.PoolExhausted,
          message: error.message || 'No relayer signer available with sufficient balance',
        },
      };
    case RelayerError.RateLimitExceeded:
      return {
        status: 429,
        body: {
          error: 'RELAY_RATE_EXCEEDED',
          retry_after: error.retryAfter ?? error.retry_after ?? 3600,
        },
      };
    case RelayerError.InvalidTransaction:
      return {
        status: 400,
        body: {
          error: RelayerError.InvalidTransaction,
          message: error.message || 'Invalid transaction XDR',
        },
      };
    default:
      return {
        status: 500,
        body: {
          error: 'RELAYER_ERROR',
          message: error?.message || 'Relayer failed to sponsor transaction',
        },
      };
  }
}

/**
 * POST /api/v1/relayer/sponsor
 * Body: { unsignedTxXdr: string }
 * Auth required.
 */
export async function sponsor(req, res) {
  const user = req.user;
  const userAddress = user?.address || user?.publicKey || user?.walletAddress;

  if (!userAddress) {
    errorsTotal?.inc?.({ type: 'relayer_sponsor', reason: 'unauthenticated' });
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Authentication required to request fee sponsorship',
    });
  }

  const unsignedXdr =
    req.body?.unsignedTxXdr || req.body?.unsignedXdr || req.body?.xdr;

  if (!unsignedXdr || typeof unsignedXdr !== 'string') {
    errorsTotal?.inc?.({ type: 'relayer_sponsor', reason: 'invalid_body' });
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      message: 'unsignedTxXdr is required',
    });
  }

  try {
    const result = await sponsorAndSign(unsignedXdr, userAddress);

    // Persist audit record for the relayed transaction.
    try {
      await logRelay({
        userAddress,
        txHash: result.txHash,
        operationType: result.operationType,
        signerAddress: result.signerAddress,
        fee: result.fee,
      });
    } catch (logError) {
      // Logging failure should not fail the relay response, but must be visible.
      logger.error('relayerController: failed to log relayed transaction', {
        error: logError?.message,
        userAddress,
        txHash: result.txHash,
      });
    }

    logger.info('relayerController: sponsored transaction', {
      userAddress,
      txHash: result.txHash,
      signerAddress: result.signerAddress,
      fee: result.fee,
      operationType: result.operationType,
    });

    return res.status(200).json({
      signedTxXdr: result.signedTxXdr,
      fee: result.fee,
      signerAddress: result.signerAddress,
    });
  } catch (error) {
    const { status, body } = mapRelayerError(error);

    errorsTotal?.inc?.({
      type: 'relayer_sponsor',
      reason: body.error,
      status: String(status),
    });

    logger.warn('relayerController: sponsor failed', {
      userAddress,
      status,
      error: body.error,
      message: error?.message,
    });

    return res.status(status).json(body);
  }
}

/**
 * GET /api/v1/relayer/pool-status
 * Returns current signer pool status.
 */
export async function poolStatus(req, res) {
  try {
    const status = await getPoolStatus();
    return res.status(200).json(status);
  } catch (error) {
    errorsTotal?.inc?.({ type: 'relayer_pool_status', reason: 'error' });
    logger.error('relayerController: failed to fetch pool status', {
      error: error?.message,
    });
    return res.status(500).json({
      error: 'RELAYER_ERROR',
      message: 'Failed to fetch relayer pool status',
    });
  }
}

export default {
  sponsor,
  poolStatus,
};