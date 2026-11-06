import { getPeer } from './peer-manager.js';

let currentCall = null;
let localStream = null;

export async function startCall(remotePeerId, video = true) {
  const peer = getPeer();
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: video ? { width: { ideal: 640 }, height: { ideal: 480 } } : false
  });

  // PeerJS MediaConnection: сигнализация уже обрабатывается PeerJS Cloud[reference:6]
  currentCall = peer.call(remotePeerId, localStream);
  return { call: currentCall, localStream };
}

export function answerCall(call, video = true) {
  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: video ? { width: { ideal: 640 } } : false
  }).then((stream) => {
    localStream = stream;
    call.answer(stream);
    currentCall = call;
    return { call, localStream };
  });
}

export function toggleMic(enabled) {
  localStream?.getAudioTracks().forEach(t => (t.enabled = enabled));
}
export function toggleCamera(enabled) {
  localStream?.getVideoTracks().forEach(t => (t.enabled = enabled));
}
export function endCall() {
  currentCall?.close();
  localStream?.getTracks().forEach(t => t.stop());
  currentCall = null;
  localStream = null;
}