import {
  handleSubmissionItem,
  handleSubmissionOptions,
} from "../../_shared/submissions.js";

export function onRequestGet({ request, env, params }) {
  return handleSubmissionItem(request, env, params.id);
}

export function onRequestPatch({ request, env, params }) {
  return handleSubmissionItem(request, env, params.id);
}

export function onRequestPost({ request, env, params }) {
  return handleSubmissionItem(request, env, params.id);
}

export function onRequestOptions({ request, env }) {
  return handleSubmissionOptions(request, env);
}
