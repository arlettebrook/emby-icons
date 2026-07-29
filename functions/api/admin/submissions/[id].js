import {
  handleAdminSubmissionDecision,
  handleSubmissionOptions,
} from "../../../_shared/submissions.js";

export function onRequestPost({ request, env, params }) {
  return handleAdminSubmissionDecision(request, env, params.id);
}

export function onRequestOptions({ request, env }) {
  return handleSubmissionOptions(request, env);
}
