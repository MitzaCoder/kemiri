/** A sign-in diagnostic safe to send to clients and write to the backend log. Never pass raw subprocess or system errors. */
export class OfficialAgentAuthError extends Error {}
