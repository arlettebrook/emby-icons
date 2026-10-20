import {
  handleMySubmissionList,
  handleSubmissionOptions,
} from "../../_shared/submissions.js";

export function onRequestGet({ request, env }) {
  return handleMySubmissionList(request, env);
}

export function onRequestOptions({ request, env }) {
  return handleSubmissionOptions(request, env);
}
