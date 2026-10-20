import {
  handleAdminSubmissionDecision,
  handleSubmissionOptions,
} from "../../../_shared/submissions.js";

export function onRequestPost({ request, env, params, waitUntil }) {
  return handleAdminSubmissionDecision(request, env, params.id, waitUntil);
}

export function onRequestOptions({ request, env }) {
  return handleSubmissionOptions(request, env);
}
