import {
  ExecProcess,
  x,
} from "tinyexec"

type PatchedExecProcess = {
  _resolveClose?: () => void;
  _resetState: () => void;
  __patchedForVitestLeaks?: boolean;
}

// oxlint-disable-next-line no-unsafe-type-assertion
const proto = ExecProcess.prototype as unknown as PatchedExecProcess

if (!proto.__patchedForVitestLeaks) {
  const originalResetState = proto._resetState

  proto._resetState = function patchedResetState(this: PatchedExecProcess) {
    this._resolveClose?.()

    return originalResetState.call(this)
  }

  proto.__patchedForVitestLeaks = true
}

export { x }
