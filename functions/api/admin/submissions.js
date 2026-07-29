import {
  handleAdminSubmissionList,
  handleSubmissionOptions,
} from "../../_shared/submissions.js";

export function onRequestGet({ request, env }) {
  return handleAdminSubmissionList(request, env);
}

export function onRequestOptions({ request, env }) {
  return handleSubmissionOptions(request, env);
}
