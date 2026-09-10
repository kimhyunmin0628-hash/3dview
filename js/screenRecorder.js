// 화면(3D 지도 캔버스) 녹화: canvas.captureStream()으로 얻은 스트림을 MediaRecorder로 받는다.
// MediaRecorder의 mp4 지원은 브라우저마다 달라서, 지원되는 형식 중 mp4를 우선 시도하고
// 안 되면 webm으로 자동 대체한다(저장되는 파일 확장자도 실제로 녹화된 형식에 맞춘다).
const RECORDING_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

function pickSupportedRecordingMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of RECORDING_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

function extensionForRecordingMimeType(mimeType) {
  return mimeType.startsWith("video/mp4") ? "mp4" : "webm";
}

function createScreenRecorder(canvas) {
  let mediaRecorder = null;
  let chunks = [];
  let mimeType = null;

  return {
    isSupported() {
      return !!pickSupportedRecordingMimeType() && typeof canvas.captureStream === "function";
    },

    isRecording() {
      return !!mediaRecorder && mediaRecorder.state === "recording";
    },

    start() {
      mimeType = pickSupportedRecordingMimeType();
      if (!mimeType) throw new Error("이 브라우저는 화면 녹화를 지원하지 않습니다.");
      const stream = canvas.captureStream(30);
      chunks = [];
      mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      mediaRecorder.start(1000); // 1초 단위로 데이터를 모아서, 너무 늦게까지 안 모이는 걸 방지
    },

    // 녹화를 멈추고 완성된 Blob과 실제 확장자를 돌려준다.
    stop() {
      return new Promise((resolve, reject) => {
        if (!mediaRecorder) {
          reject(new Error("녹화 중이 아닙니다."));
          return;
        }
        mediaRecorder.onstop = () => {
          const blob = new Blob(chunks, { type: mimeType });
          const ext = extensionForRecordingMimeType(mimeType);
          chunks = [];
          mediaRecorder = null;
          resolve({ blob, ext });
        };
        mediaRecorder.stop();
      });
    },
  };
}

// Blob을 파일로 저장한다. File System Access API를 지원하는 브라우저(Chrome/Edge)에서는
// 파일명과 저장 폴더를 직접 고르는 네이티브 저장 대화상자를 띄우고, 지원하지 않으면
// 기본 다운로드 폴더로 저장하는 방식으로 대체한다(그 경우 폴더 지정은 불가).
async function saveBlobAsFile(blob, suggestedName) {
  if (typeof window.showSaveFilePicker === "function") {
    const ext = suggestedName.split(".").pop();
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [
        {
          description: ext.toUpperCase() + " 비디오",
          accept: { [blob.type || "video/*"]: ["." + ext] },
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return "picker";
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "download";
}
