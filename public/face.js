// Face detection and recognition in the browser (shared by the tablet and the admin enrolment screen).
// Nothing leaves the device except the 128-number descriptor of a face.

const BASE = '/vendor/face-api';
let faceapi = null;

export async function loadFaceApi() {
  if (faceapi) return faceapi;
  const mod = await import(`${BASE}/face-api.esm.js`);
  await Promise.all([
    mod.nets.tinyFaceDetector.loadFromUri(`${BASE}/model`),
    mod.nets.faceLandmark68Net.loadFromUri(`${BASE}/model`),
    mod.nets.faceRecognitionNet.loadFromUri(`${BASE}/model`),
  ]);
  faceapi = mod;
  return mod;
}

export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('הדפדפן לא תומך במצלמה. יש לפתוח ב-Chrome או ב-Edge.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  } catch (err) {
    throw new Error(err.name === 'NotAllowedError'
      ? 'לא ניתנה הרשאה למצלמה. יש לאשר את המצלמה בדפדפן (סמל המנעול ליד הכתובת) ולרענן.'
      : 'לא נמצאה מצלמה פעילה במכשיר.');
  }
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  return stream;
}

export function stopCamera(video) {
  video.srcObject?.getTracks().forEach(t => t.stop());
  video.srcObject = null;
}

// The single largest face in the frame, or null. size = the face's width as a share of the frame.
export async function detectFace(video) {
  const res = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
    .withFaceLandmarks().withFaceDescriptor();
  if (!res) return null;
  const pts = res.landmarks.positions;
  return {
    descriptor: Array.from(res.descriptor),
    score: res.detection.score,
    size: res.detection.box.width / (video.videoWidth || 640),
    yaw: yaw(pts),
    ear: (eyeRatio(pts.slice(36, 42)) + eyeRatio(pts.slice(42, 48))) / 2,
  };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// How far the nose sits from the middle of the eyes, relative to the eye distance: about 0 when facing
// the camera, growing as the head turns. A photo held up and moved keeps it almost fixed.
function yaw(p) {
  const l = p[39], r = p[42], nose = p[30];
  const mid = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  return (nose.x - mid.x) / (dist(p[36], p[45]) || 1);
}

// Eye aspect ratio: drops sharply while the eye is closed (a blink)
function eyeRatio(e) {
  return (dist(e[1], e[5]) + dist(e[2], e[4])) / (2 * dist(e[0], e[3]) || 1);
}

export function faceDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

// Best match among people = [{ id, descriptors: [[...]] }]; null when nobody is close enough.
// 0.5 is stricter than the library's usual 0.6, so a stranger is less likely to pass as someone else.
export function bestMatch(descriptor, people, threshold = 0.5) {
  let best = null;
  for (const p of people) {
    for (const d of p.descriptors) {
      const dd = faceDistance(descriptor, d);
      if (dd < threshold && (!best || dd < best.distance)) best = { person: p, distance: dd };
    }
  }
  return best;
}

// Liveness: within the check the head must turn a little, or the eyes must blink.
export class LivenessCheck {
  constructor() { this.minYaw = Infinity; this.maxYaw = -Infinity; this.openEar = 0; this.blinked = false; }
  add(f) {
    this.minYaw = Math.min(this.minYaw, f.yaw);
    this.maxYaw = Math.max(this.maxYaw, f.yaw);
    if (f.ear > 0.26) this.openEar = Math.max(this.openEar, f.ear);
    if (this.openEar && f.ear < this.openEar * 0.7) this.blinked = true;
  }
  get passed() { return this.blinked || this.maxYaw - this.minYaw > 0.18; }
}
