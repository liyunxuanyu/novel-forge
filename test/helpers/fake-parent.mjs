/**
 * 共用假父级 agent。
 *
 * 真引擎 start() 里做 `request.parent.session`——硬解引用。
 * 而宿主里 exec.agent 是**确实可能缺席**的（dsh-tools 自己派发都写
 * `...exec.agent ? { agent: exec.agent } : {}`），后台自动跑时最常见。
 *
 * 于是测试里每个「正常派发成功」的场景都必须喂一个**像样的** parent，
 * 否则测的是一条真机上根本走不到的路径。以前大家都没喂，
 * 于是 guard 一上线，34 条老测试集体变红——那说明老测试本来就不忠实，
 * 不是 guard 错了。
 */

/** 一个真引擎看得过去的父级 agent。 */
export const FAKE_PARENT = Object.freeze({ session: Object.freeze({ id: "test-session" }) });

/** 造一个带假 parent 的执行上下文，喂给工具的 execute。 */
export function fakeExec(extra = {}) {
  return { agent: FAKE_PARENT, signal: new AbortController().signal, ...extra };
}