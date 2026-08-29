/**
 * Compatibility export retained for callers that imported the original
 * Gmail-named interface. Correlation is provider-neutral now; founder Zoho
 * ingestion is isolated in the job-search poller and never enters a customer
 * workspace inbox.
 */
export {
  correlateRecruiterEmail,
  type RecruiterEmailCorrelationInput,
  type RecruiterEmailCorrelationResult,
} from './email-correlation'
