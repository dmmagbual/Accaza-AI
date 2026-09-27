"use strict";
// The agent loop for one laptop task. Pure logic: Firestore, Docker and the models are passed in,
// so it can be unit tested with fakes.
//
// Each step: the model sees the task so far and either calls tools or answers. Tool calls run one
// by one; their results go back to the model on the next step. The state (transcript, step count,
// a pending question) is saved after every step, so a task survives a worker restart or a pause
// for the user's answer.
const {toolResultText} = require("./models");

const DEFAULT_LIMITS = {maxSteps: 40, maxMinutes: 30, maxCallsPerStep: 6};

// state: {transcript, steps, pending?: {results, ask: {id, name, question}}}
function initialState(prompt, inputNames) {
  const files = inputNames.length ? `\n\n[Files attached by the user, in /workspace/inputs: ${inputNames.join(", ")}]` : "";
  return {transcript: [{role: "user", text: `${prompt}${files}`}], steps: 0};
}
// Resuming after the user answered a question: the answer becomes the ask_user tool result.
function applyReply(state, replyText) {
  if (!state.pending) return state;
  const results = state.pending.results.slice();
  results.push({id: state.pending.ask.id, name: state.pending.ask.name, result: {answer: String(replyText || "(no answer)")}});
  const order = state.pending.order || results.map(r => r.id);
  results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return {transcript: [...state.transcript, {role: "tool", results}], steps: state.steps};
}

// deps: {chain, tools, system, save(state), event(e), shouldStop(), signal, now(), limits, startedAt}
// Returns {status: "done"|"waiting"|"stopped"|"failed", summary?, question?, error?, state}.
async function runAgent(state, deps) {
  const limits = Object.assign({}, DEFAULT_LIMITS, deps.limits || {});
  const now = deps.now || (() => Date.now());
  const deadline = (deps.startedAt || now()) + limits.maxMinutes * 60000;
  let st = state;
  while (true) {
    if (await deps.shouldStop()) return {status: "stopped", state: st};
    const outOfSteps = st.steps >= limits.maxSteps, outOfTime = now() > deadline;
    if (outOfSteps || outOfTime) {
      // One last call without tools, so the user still gets a summary of what was done.
      const why = outOfSteps ? `the ${limits.maxSteps}-step limit` : `the ${limits.maxMinutes}-minute limit`;
      const closing = [...st.transcript, {role: "user", text: `You have reached ${why} for this task. Stop now. Reply with a short summary of what is finished, which files are in /workspace/outputs, and what is still left to do.`}];
      try {
        const last = await deps.chain.step({system: deps.system, transcript: closing, tools: [], signal: deps.signal});
        return {status: "done", summary: `${last.text || "The task reached its limit."}\n\n*Stopped at ${why}.*`, state: st, limitReached: true};
      } catch (error) {
        return {status: "failed", error: `Reached ${why} and could not write a summary.`, state: st};
      }
    }
    let res;
    try { res = await deps.chain.step({system: deps.system, transcript: st.transcript, tools: deps.tools.declarations, signal: deps.signal}); }
    catch (error) {
      if (error && error.stopped) return {status: "stopped", state: st};
      return {status: "failed", error: String(error && error.message || error).slice(0, 500), state: st};
    }
    const calls = (res.calls || []).slice(0, limits.maxCallsPerStep);
    const assistant = {role: "assistant", text: res.text || "", calls};
    if (res.gemini && calls.length === (res.calls || []).length) assistant.gemini = res.gemini;
    st = {transcript: [...st.transcript, assistant], steps: st.steps + 1};
    if (res.failures && res.failures.length) await deps.event({type: "note", label: `${res.failures.map(f => f.provider).join(", ")} unavailable; ${res.provider} continued`, status: "done", detail: res.failures.map(f => f.reason).join("\n").slice(0, 800)});
    if (!calls.length) {
      await deps.save(st);
      return {status: "done", summary: res.text, state: st, provider: res.provider};
    }
    if (res.text) await deps.event({type: "text", label: res.text.slice(0, 300), status: "done", detail: res.text.length > 300 ? res.text.slice(0, 2000) : ""});
    const results = [];
    let ask = null;
    for (const call of calls) {
      if (call.name === "ask_user" && !ask) { ask = {id: call.id, name: call.name, question: String(call.args && call.args.question || "").trim().slice(0, 1000) || "Could you give me more detail?"}; continue; }
      if (call.name === "ask_user") { results.push({id: call.id, name: call.name, result: {error: "Only one question at a time."}}); continue; }
      if (await deps.shouldStop()) return {status: "stopped", state: st};
      if ((deps.tools.silent || []).includes(call.name)) { results.push({id: call.id, name: call.name, result: capResult(await deps.tools.run(call.name, call.args))}); continue; }
      const label = deps.tools.label(call.name, call.args);
      const seq = await deps.event({type: "tool", label, status: "running", detail: ""});
      const started = now();
      const result = await deps.tools.run(call.name, call.args);
      const failed = Boolean(result && result.error) || (result && typeof result.exit_code === "number" && result.exit_code !== 0);
      await deps.event({type: "tool", label, status: failed ? "failed" : "done", detail: deps.tools.detail(call.name, call.args, result), ms: now() - started, of: seq});
      results.push({id: call.id, name: call.name, result: capResult(result)});
    }
    if (ask) {
      st = Object.assign({}, st, {pending: {results, ask, order: calls.map(c => c.id)}});
      await deps.save(st);
      return {status: "waiting", question: ask.question, state: st};
    }
    st = {transcript: [...st.transcript, {role: "tool", results}], steps: st.steps};
    await deps.save(st);
  }
}
function capResult(result, max = 14000) {
  const text = toolResultText(result);
  return text.length > max ? {truncated: true, partial: text.slice(0, max)} : result;
}

module.exports = {DEFAULT_LIMITS, initialState, applyReply, runAgent, capResult};
