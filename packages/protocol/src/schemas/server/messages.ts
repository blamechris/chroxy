/**
 * Inferred TypeScript types (z.infer) for the server→client message schemas. Terminal domain — imports schema values from every sibling for the type queries.
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). Split per #6201 Tier-3.
 */

import { z } from 'zod'

import { BillingCanarySnapshotSchema, BillingCanaryWarningSchema, ServerAuthOkSchema, ServerPairPendingSchema, ServerPairRequestPendingSchema, ServerPairResolvedSchema, ServerPairResultSchema } from './connection.ts'
import { ServerPermissionRequestSchema, ServerPermissionInputSchema, ServerPermissionExpiredSchema, ServerPermissionResolvedSchema, ServerStreamDeltaSchema, ServerShellPendingApprovalSchema } from './stream.ts'
import { ActivityEntrySchema, ActivityKindSchema, ActivityOutputRefSchema, ActivityStatusSchema, ServerActivityDeltaSchema, ServerActivitySnapshotSchema, ServerCancelActivityAckSchema, ServerMessageDequeuedSchema, ServerMessageQueuedSchema } from './activity.ts'
import { ExternalSessionEntrySchema, HostStatusSummarySchema, IntegrationActionCountsSchema, IntegrationCliStatusSchema, IntegrationRepoSchema, IntegrationStatusSummarySchema, MailboxDeliveryEventSchema, MailboxRegistrationSchema, RepoEventSchema, ServerRepoEventsDeltaSchema, RepoWebhookDeliveriesSchema, ServerGithubWebhookConfigSchema, RepoMemoryCacheSchema, RepoMemoryReportSchema, RepoMemoryStatusSchema, RepoRelayRunSchema, RepoRelayStatusSchema, RepoRelayVerdictSchema, RepoRunnersSchema, RepoRuntimeConfigEntrySchema, RepoStatusSchema, RepoTreeSchema, RepoVerdictSchema, RunnerInfoSchema, RunnerServiceStateSchema, RunnerStatusSummarySchema, RunnerVerdictSchema, ServerByokPoolActionAckSchema, ServerByokPoolStatusSnapshotSchema, ServerContainersActionAckSchema, ServerContainersStatusSnapshotSchema, ServerEmulatorActionAckSchema, ServerEmulatorStatusSnapshotSchema, ServerExternalSessionsSnapshotSchema, ServerHostPruneActionAckSchema, ServerHostPruneStatusSnapshotSchema, ServerHostStatusSnapshotSchema, ServerIntegrationActionAckSchema, ServerIntegrationStatusSnapshotSchema, ServerMailboxStatusSnapshotSchema, ServerRepoEventsSnapshotSchema, ServerRepoRuntimeConfigSnapshotSchema, ServerRunnerStatusSnapshotSchema, ServerSessionPresetDisclosureSchema, ServerSessionPresetFullSchema, ServerSessionPresetSnapshotSchema, ServerSimulatorActionAckSchema, ServerSimulatorStatusSnapshotSchema, ServerSkillsInventorySnapshotSchema, ServerSummarizeSessionResultSchema, ServerWslActionAckSchema, ServerWslStatusSnapshotSchema, SkillInventoryEntrySchema, SkillInventoryRepoSchema } from './control-room.ts'
import { CumulativeUsageSchema, ServerAuthBootstrapSchema, ServerConversationIdSchema, ServerSessionStoppedSchema, ServerSkillTrustGrantInvalidAuthorSchema, ServerSkillTrustGrantOkSchema, ServerSkillsListSchema, ServerTunnelUrlChangedSchema } from './session.ts'
import { ServerBillingCanarySchema, ServerBudgetResumeAckSchema, ServerByokCredentialsStatusSchema, ServerCostUpdateSchema, ServerCredentialTestResultSchema, ServerCredentialsStatusSchema, ServerErrorEnvelopeSchema, ServerErrorSchema, ServerEvaluateDraftResultSchema, ServerEvaluatorClarifySchema, ServerEvaluatorRewriteSchema, ServerExtensionMessageSchema, ServerMonthlyBudgetSchema, ServerSessionCostThresholdCrossedSchema, ServerSessionUsageSchema } from './billing.ts'

// -- Inferred TypeScript types --

export type BillingCanaryWarning = z.infer<typeof BillingCanaryWarningSchema>
export type BillingCanarySnapshot = z.infer<typeof BillingCanarySnapshotSchema>
export type ServerBillingCanaryMessage = z.infer<typeof ServerBillingCanarySchema>
export type ServerAuthOkMessage = z.infer<typeof ServerAuthOkSchema>
export type ServerPairRequestPendingMessage = z.infer<typeof ServerPairRequestPendingSchema>
export type ServerPairPendingMessage = z.infer<typeof ServerPairPendingSchema>
export type ServerPairResultMessage = z.infer<typeof ServerPairResultSchema>
export type ServerPairResolvedMessage = z.infer<typeof ServerPairResolvedSchema>
export type ServerStreamDeltaMessage = z.infer<typeof ServerStreamDeltaSchema>
// #6277 — host-local user-shell approval pending notice (dashboard-only v1).
export type ServerShellPendingApprovalMessage = z.infer<typeof ServerShellPendingApprovalSchema>
export type ServerPermissionRequestMessage = z.infer<typeof ServerPermissionRequestSchema>
// #6891: typed aliases for the permission-lifecycle broadcasts that gained a
// schema — a pending prompt expiring, and a prompt resolving (requestId variant).
export type ServerPermissionExpiredMessage = z.infer<typeof ServerPermissionExpiredSchema>
export type ServerPermissionResolvedMessage = z.infer<typeof ServerPermissionResolvedSchema>
// #6891: typed alias for the SDK conversation-handle stamp used for session
// portability.
export type ServerConversationIdMessage = z.infer<typeof ServerConversationIdSchema>
// #6543 (IDE P3 feature B): reply to a get_permission_input pull — the full
// secret-redacted tool input for building a pre-write diff.
export type ServerPermissionInputMessage = z.infer<typeof ServerPermissionInputSchema>
export type ServerErrorMessage = z.infer<typeof ServerErrorSchema>
// #4192: typed alias for the generic `type: 'error'` envelope added in #4178.
// Downstream consumers (store-core handleError, dashboard message-handler,
// future mobile dispatch) can import this directly instead of re-running
// `z.infer<typeof ServerErrorEnvelopeSchema>` at each call site.
export type ServerErrorEnvelopeMessage = z.infer<typeof ServerErrorEnvelopeSchema>
export type ServerCostUpdateMessage = z.infer<typeof ServerCostUpdateSchema>
export type CumulativeUsage = z.infer<typeof CumulativeUsageSchema>
export type ServerSessionUsageMessage = z.infer<typeof ServerSessionUsageSchema>
// #4756: typed alias for the user-initiated Stop confirmation broadcast.
export type ServerSessionStoppedMessage = z.infer<typeof ServerSessionStoppedSchema>
export type ServerSessionCostThresholdCrossedMessage = z.infer<typeof ServerSessionCostThresholdCrossedSchema>
// #5665: machine-wide monthly programmatic-credit meter snapshot/event.
export type ServerMonthlyBudgetMessage = z.infer<typeof ServerMonthlyBudgetSchema>
export type ServerExtensionMessage = z.infer<typeof ServerExtensionMessageSchema>
export type ServerSkillsListMessage = z.infer<typeof ServerSkillsListSchema>
export type ServerAuthBootstrapMessage = z.infer<typeof ServerAuthBootstrapSchema>
// #5555 (sub-item 7) — quick-tunnel URL rotation push.
export type ServerTunnelUrlChangedMessage = z.infer<typeof ServerTunnelUrlChangedSchema>
export type ServerEvaluateDraftResultMessage = z.infer<typeof ServerEvaluateDraftResultSchema>
export type ServerEvaluatorRewriteMessage = z.infer<typeof ServerEvaluatorRewriteSchema>
export type ServerEvaluatorClarifyMessage = z.infer<typeof ServerEvaluatorClarifySchema>
export type ServerSkillTrustGrantOkMessage = z.infer<typeof ServerSkillTrustGrantOkSchema>
export type ServerSkillTrustGrantInvalidAuthorMessage = z.infer<typeof ServerSkillTrustGrantInvalidAuthorSchema>
// #4141: typed BYOK credentials status payload.
export type ServerByokCredentialsStatusMessage = z.infer<typeof ServerByokCredentialsStatusSchema>
// #3855: generalized provider-credential status + test-result payloads.
export type ServerCredentialsStatusMessage = z.infer<typeof ServerCredentialsStatusSchema>
export type ServerCredentialTestResultMessage = z.infer<typeof ServerCredentialTestResultSchema>
// #5161: Control Room activity-tree wire contract. Consumed by the server
// emitter (#5160), store-core reducer (#5162), and dashboard panel (#5163).
export type ActivityKind = z.infer<typeof ActivityKindSchema>
export type ActivityStatus = z.infer<typeof ActivityStatusSchema>
export type ActivityOutputRef = z.infer<typeof ActivityOutputRefSchema>
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>
export type ServerActivitySnapshotMessage = z.infer<typeof ServerActivitySnapshotSchema>
export type ServerActivityDeltaMessage = z.infer<typeof ServerActivityDeltaSchema>
// #5277: positive ack for an actioned cancel_activity request.
export type ServerCancelActivityAckMessage = z.infer<typeof ServerCancelActivityAckSchema>
// #5936: outgoing-message queue mirror events.
export type ServerMessageQueuedMessage = z.infer<typeof ServerMessageQueuedSchema>
export type ServerMessageDequeuedMessage = z.infer<typeof ServerMessageDequeuedSchema>
// #5752: positive ack for an actioned resume_budget request.
export type ServerBudgetResumeAckMessage = z.infer<typeof ServerBudgetResumeAckSchema>
// #5171: Host/Repo Status Control Room wire contract (#5170 epic). Consumed by
// the server emitter, store-core reducer, and dashboard panel in sibling issues.
export type RepoVerdict = z.infer<typeof RepoVerdictSchema>
export type RepoTree = z.infer<typeof RepoTreeSchema>
export type RepoStatus = z.infer<typeof RepoStatusSchema>
export type HostStatusSummary = z.infer<typeof HostStatusSummarySchema>
export type ServerHostStatusSnapshotMessage = z.infer<typeof ServerHostStatusSnapshotSchema>
export type ServerMailboxStatusSnapshotMessage = z.infer<typeof ServerMailboxStatusSnapshotSchema>
export type ExternalSessionEntry = z.infer<typeof ExternalSessionEntrySchema>
export type ServerExternalSessionsSnapshotMessage = z.infer<typeof ServerExternalSessionsSnapshotSchema>
// #5966 (epic #5422 phase 5): Control Room repo-events survey contract. Consumed
// by the server emitter (control-room-handlers.js), the dashboard store handler,
// and the RepoEventsSection pane.
export type RepoEvent = z.infer<typeof RepoEventSchema>
export type ServerRepoEventsSnapshotMessage = z.infer<typeof ServerRepoEventsSnapshotSchema>
export type ServerRepoEventsDeltaMessage = z.infer<typeof ServerRepoEventsDeltaSchema>
// #6540 (item 3 of #6536): repo-events webhook-secret config surface. Consumed by
// the server emitter (github-webhook-handlers.js), the dashboard store handler,
// and the GithubWebhookConfig pane inside RepoEventsSection.
export type RepoWebhookDeliveries = z.infer<typeof RepoWebhookDeliveriesSchema>
export type ServerGithubWebhookConfigMessage = z.infer<typeof ServerGithubWebhookConfigSchema>
export type MailboxRegistration = z.infer<typeof MailboxRegistrationSchema>
export type MailboxDeliveryEvent = z.infer<typeof MailboxDeliveryEventSchema>

// #5553: per-repo session preset wire types.
export type ServerSessionPresetDisclosure = z.infer<typeof ServerSessionPresetDisclosureSchema>
export type ServerSessionPresetFull = z.infer<typeof ServerSessionPresetFullSchema>
export type ServerSessionPresetSnapshotMessage = z.infer<typeof ServerSessionPresetSnapshotSchema>

// #5253: Self-hosted runner status Control Room contract. Consumed by the
// server emitter (runners.js), the dashboard store handler, and the
// RunnerStatusSection panel.
export type RunnerVerdict = z.infer<typeof RunnerVerdictSchema>
export type RunnerServiceState = z.infer<typeof RunnerServiceStateSchema>
export type RunnerInfo = z.infer<typeof RunnerInfoSchema>
export type RepoRunners = z.infer<typeof RepoRunnersSchema>
export type RunnerStatusSummary = z.infer<typeof RunnerStatusSummarySchema>
export type ServerRunnerStatusSnapshotMessage = z.infer<typeof ServerRunnerStatusSnapshotSchema>
export type ServerContainersStatusSnapshotMessage = z.infer<typeof ServerContainersStatusSnapshotSchema>
export type ServerRepoRuntimeConfigSnapshotMessage = z.infer<typeof ServerRepoRuntimeConfigSnapshotSchema>
export type RepoRuntimeConfigEntry = z.infer<typeof RepoRuntimeConfigEntrySchema>
export type ServerByokPoolStatusSnapshotMessage = z.infer<typeof ServerByokPoolStatusSnapshotSchema>

// #5499 (epic #5498): Integrations tab Control Room contract. Consumed by the
// server emitter (control-room/integrations.js), the dashboard store handler,
// and the IntegrationsSection panel.
export type RepoMemoryCache = z.infer<typeof RepoMemoryCacheSchema>
export type RepoMemoryReport = z.infer<typeof RepoMemoryReportSchema>
export type RepoMemoryStatus = z.infer<typeof RepoMemoryStatusSchema>
// #5501: repo-relay observability block (sibling to RepoMemoryStatus).
export type RepoRelayRun = z.infer<typeof RepoRelayRunSchema>
export type RepoRelayVerdict = z.infer<typeof RepoRelayVerdictSchema>
export type RepoRelayStatus = z.infer<typeof RepoRelayStatusSchema>
export type IntegrationRepo = z.infer<typeof IntegrationRepoSchema>
export type IntegrationStatusSummary = z.infer<typeof IntegrationStatusSummarySchema>
export type IntegrationCliStatus = z.infer<typeof IntegrationCliStatusSchema>
export type ServerIntegrationStatusSnapshotMessage = z.infer<typeof ServerIntegrationStatusSnapshotSchema>
// #5500 — Reindex action ack (epic #5498); request side is
// `IntegrationActionMessage` in client.ts.
export type IntegrationActionCounts = z.infer<typeof IntegrationActionCountsSchema>
export type ServerIntegrationActionAckMessage = z.infer<typeof ServerIntegrationActionAckSchema>
export type ServerContainersActionAckMessage = z.infer<typeof ServerContainersActionAckSchema>
export type ServerByokPoolActionAckMessage = z.infer<typeof ServerByokPoolActionAckSchema>
export type ServerHostPruneStatusSnapshotMessage = z.infer<typeof ServerHostPruneStatusSnapshotSchema>
export type ServerHostPruneActionAckMessage = z.infer<typeof ServerHostPruneActionAckSchema>
export type ServerSimulatorStatusSnapshotMessage = z.infer<typeof ServerSimulatorStatusSnapshotSchema>
export type ServerSimulatorActionAckMessage = z.infer<typeof ServerSimulatorActionAckSchema>
export type ServerEmulatorStatusSnapshotMessage = z.infer<typeof ServerEmulatorStatusSnapshotSchema>
export type ServerEmulatorActionAckMessage = z.infer<typeof ServerEmulatorActionAckSchema>
export type ServerWslStatusSnapshotMessage = z.infer<typeof ServerWslStatusSnapshotSchema>
export type ServerWslActionAckMessage = z.infer<typeof ServerWslActionAckSchema>
// #5554 — Skills inventory tab (epic #5159); request side is
// `SkillsInventoryRequestMessage` in client.ts. Consumed by the server emitter
// (control-room/skills-inventory.js), the dashboard store handler, and the
// SkillsInventorySection panel.
export type SkillInventoryEntry = z.infer<typeof SkillInventoryEntrySchema>
export type SkillInventoryRepo = z.infer<typeof SkillInventoryRepoSchema>
export type ServerSkillsInventorySnapshotMessage = z.infer<typeof ServerSkillsInventorySnapshotSchema>
export type ServerSummarizeSessionResultMessage = z.infer<typeof ServerSummarizeSessionResultSchema>
