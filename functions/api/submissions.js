import {
  handleSubmissionCreate,
  handleSubmissionOptions,
} from "../_shared/submissions.js";

export function onRequestPost({ request, env, waitUntil }) {
  return handleSubmissionCreate(request, env, waitUntil);
}

export function onRequestOptions({ request, env }) {
  return handleSubmissionOptions(request, env);
}
