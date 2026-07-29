import {
  handleSubmissionCreate,
  handleSubmissionOptions,
} from "../_shared/submissions.js";

export function onRequestPost({ request, env }) {
  return handleSubmissionCreate(request, env);
}

export function onRequestOptions({ request, env }) {
  return handleSubmissionOptions(request, env);
}
