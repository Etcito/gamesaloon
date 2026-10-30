// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Zone relay binary frames: client destination mask in, sender byte out.

export const BIN_KIND = 0x5a
export const BIN_IN_HEADER = 10
export const BIN_OUT_HEADER = 2

export interface BinIn {
  maskLo: number
  maskHi: number
  payload: Uint8Array
}

const decoded: BinIn = { maskLo: 0, maskHi: 0, payload: new Uint8Array(0) }

/** One allocation per relayed frame, shared by every recipient. */
export function encodeBinOut(sender: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(BIN_OUT_HEADER + payload.byteLength)
  out[0] = BIN_KIND
  out[1] = sender
  out.set(payload, BIN_OUT_HEADER)
  return out
}

/** Never throws; the result object is reused, so copy a payload you keep. */
export function decodeBinIn(frame: Uint8Array): BinIn | null {
  if (frame.byteLength < BIN_IN_HEADER) return null
  if (frame[0] !== BIN_KIND || frame[1] !== 0) return null
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  decoded.maskLo = view.getUint32(2, true)
  decoded.maskHi = view.getUint32(6, true)
  decoded.payload = frame.subarray(BIN_IN_HEADER)
  return decoded
}
