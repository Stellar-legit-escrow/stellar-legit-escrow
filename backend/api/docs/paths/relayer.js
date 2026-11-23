/**
 * @openapi
 * /api/relayer/execute:
 *   post:
 *     tags: [Relayer]
 *     summary: Execute a meta-transaction (gasless interaction)
 *     description: |
 *       Submits a meta-transaction to the Stellar network on behalf of the user.
 *       The relayer pays the transaction fee, enabling gasless interactions with the escrow contract.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [metaTx]
 *             properties:
 *               metaTx:
 *                 type: object
 *                 description: Signed meta-transaction payload
 *               feeDelegation:
 *                 type: object
 *                 description: Optional fee delegation parameters
 *           examples:
 *             execute:
 *               summary: Execute a meta-transaction
 *               value:
 *                 metaTx:
 *                   nonce: 1
 *                   signature: "abc123..."
 *                   callData: "..."
 *     responses:
 *       200:
 *         description: Meta-transaction executed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 transactionHash:
 *                   type: string
 *                   example: "abc123def456..."
 *                 ledger:
 *                   type: integer
 *                   example: 1234567
 *                 nonce:
 *                   type: integer
 *                   example: 1
 *       400:
 *         description: Invalid meta-transaction or execution failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                 nonce:
 *                   type: integer
 *       500:
 *         $ref: '#/components/responses/InternalError'
 *
 * /api/relayer/fee-estimate:
 *   post:
 *     tags: [Relayer]
 *     summary: Estimate the fee for a meta-transaction
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [metaTx]
 *             properties:
 *               metaTx:
 *                 type: object
 *                 description: Meta-transaction payload to estimate fee for
 *     responses:
 *       200:
 *         description: Fee estimate
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 estimatedFee:
 *                   type: string
 *                   description: Estimated fee in stroops
 *                   example: "100"
 *                 feeToken:
 *                   type: string
 *                   example: "XLM"
 *                 unit:
 *                   type: string
 *                   example: "stroops"
 *       400:
 *         description: Missing meta-transaction data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 *
 * /api/v1/relayer/sponsor:
 *   post:
 *     tags: [Relayer]
 *     summary: Sponsor and sign a gasless transaction
 *     description: |
 *       Wraps an unsigned transaction XDR in a fee-bump envelope signed by a
 *       fee-sponsoring account from the relayer signer pool. Only whitelisted
 *       operations (e.g. `invoke_host_function`) are sponsored. The client must
 *       still submit the returned signed XDR via `stellarService.submitTransaction`.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [unsignedXdr]
 *             properties:
 *               unsignedXdr:
 *                 type: string
 *                 description: Base64-encoded unsigned transaction envelope XDR
 *                 example: "AAAAAgAAAAB..."
 *               userAddress:
 *                 type: string
 *                 description: Optional Stellar account of the user (defaults to the authenticated user)
 *                 example: "GABC...XYZ"
 *           examples:
 *             sponsor:
 *               summary: Sponsor a Soroban contract call
 *               value:
 *                 unsignedXdr: "AAAAAgAAAAB..."
 *     responses:
 *       200:
 *         description: Transaction sponsored and signed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 signedXdr:
 *                   type: string
 *                   description: Base64-encoded fee-bump envelope XDR
 *                   example: "AAAAAgAAAAB..."
 *                 fee:
 *                   type: integer
 *                   description: Fee paid by the sponsor in stroops
 *                   example: 100
 *                 signerAddress:
 *                   type: string
 *                   description: Stellar account that sponsored the fee
 *                   example: "GABC...XYZ"
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       422:
 *         description: Operation type not allowed for sponsorship
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: string
 *                   example: "OperationNotAllowed"
 *                 error:
 *                   type: string
 *                   example: "Operation type 'payment' is not allowed for sponsorship"
 *       429:
 *         description: Per-user relay rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: string
 *                   example: "RELAY_RATE_EXCEEDED"
 *                 retry_after:
 *                   type: integer
 *                   description: Seconds until the next relay is permitted
 *                   example: 3600
 *       503:
 *         description: No signer with sufficient balance is available
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: string
 *                   example: "PoolExhausted"
 *                 error:
 *                   type: string
 *                   example: "No signer with sufficient balance available"
 *       500:
 *         $ref: '#/components/responses/InternalError'
 *
 * /api/v1/relayer/pool-status:
 *   get:
 *     tags: [Relayer]
 *     summary: Get the relayer signer pool status
 *     responses:
 *       200:
 *         description: Signer pool status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 available:
 *                   type: integer
 *                   description: Number of signers with sufficient balance
 *                   example: 3
 *                 total:
 *                   type: integer
 *                   description: Total number of signers in the pool
 *                   example: 5
 *                 lowestBalance:
 *                   type: number
 *                   description: Lowest XLM balance among available signers
 *                   example: 12.5
 *       500:
 *         $ref: '#/components/responses/InternalError'
 *
 * /api/relayer/status:
 *   get:
 *     tags: [Relayer]
 *     summary: Get relayer service status
 *     responses:
 *       200:
 *         description: Relayer status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: "active"
 *                 network:
 *                   type: string
 *                   example: "testnet"
 *                 contractId:
 *                   type: string
 *                   example: "CABC...XYZ"
 *                 relayerAddress:
 *                   type: string
 *                   example: "GABC...XYZ"
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */
