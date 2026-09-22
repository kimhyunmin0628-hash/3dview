// 화면(3D 지도 캔버스) 녹화: canvas.captureStream()으로 얻은 스트림을 MediaRecorder로 받는다.
// MediaRecorder의 mp4 지원은 브라우저마다 달라서, 지원되는 형식 중 mp4를 우선 시도하고
// 안 되면 webm으로 자동 대체한다(저장되는 파일 확장자도 실제로 녹화된 형식에 맞춘다).

// 녹화/캡처 모두 유튜브 표준 화면비(16:9)로 저장한다. 실제 지도 캔버스는 창 크기에 따라
// 비율이 제각각이라, 저장할 때는 항상 중앙 기준으로 16:9에 맞는 최대 영역만 잘라 쓴다.
const CAPTURE_ASPECT_RATIO = 16 / 9;

// 원본 캔버스(sourceWidth x sourceHeight) 안에서 targetRatio에 맞는 가장 큰 중앙 영역의
// 좌표를 구한다. 원본이 더 옆으로 넓으면 좌우를, 더 위아래로 길면 상하를 잘라낸다.
function computeAspectCrop(sourceWidth, sourceHeight, targetRatio) {
  const sourceRatio = sourceWidth / sourceHeight;
  let sw, sh;
  if (sourceRatio > targetRatio) {
    sh = sourceHeight;
    sw = Math.round(sourceHeight * targetRatio);
  } else {
    sw = sourceWidth;
    sh = Math.round(sourceWidth / targetRatio);
  }
  return { sx: Math.floor((sourceWidth - sw) / 2), sy: Math.floor((sourceHeight - sh) / 2), sw, sh };
}

// 실시간 조작(드론수동조정 키보드, 조망뷰 방향패드) 중 눌림 상태가 바뀌는 순간들을
// 타임라인으로 기록해뒀다가, 나중에 고정 프레임(실제 시간과 무관하게 정해진 간격)으로 그대로
// 재현하기 위한 범용 기록기. 조작 자체는 실시간으로 그대로 보여주고, 녹화 대상 영상만 따로
// "그 조작을 그대로 다시 재생"해서 고정 프레임 방식으로 매끄럽게 만드는 데 쓴다.
function createInputTimelineRecorder() {
  let recording = false;
  let startTime = 0;
  let events = [];

  return {
    isRecording() {
      return recording;
    },
    start() {
      recording = true;
      startTime = performance.now();
      events = [];
    },
    // key 상태가 실제로 바뀔 때만(키 리핏 등 중복 아님) 호출해야 한다.
    logChange(key, pressed) {
      if (!recording) return;
      events.push({ tSec: (performance.now() - startTime) / 1000, key, pressed });
    },
    stop() {
      recording = false;
      return { events, durationSec: (performance.now() - startTime) / 1000 };
    },
  };
}

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
  let captureCanvas = null;
  let captureCtx = null;
  let cropRect = null;
  let drawLoopId = null;
  let lockedTrack = null; // 고정 프레임 모드에서만 쓰는, 수동으로 프레임을 밀어넣는 비디오 트랙

  function setupCaptureCanvas() {
    cropRect = computeAspectCrop(canvas.width, canvas.height, CAPTURE_ASPECT_RATIO);
    captureCanvas = document.createElement("canvas");
    captureCanvas.width = cropRect.sw;
    captureCanvas.height = cropRect.sh;
    captureCtx = captureCanvas.getContext("2d");
  }

  // 원본 캔버스에서 16:9 영역만 오려서 녹화용 캔버스에 그려 넣는다. MediaRecorder는 원본이
  // 아니라 이 캔버스의 스트림을 받으므로, 저장되는 영상은 항상 16:9가 된다.
  function drawCroppedFrameOnce() {
    captureCtx.drawImage(
      canvas,
      cropRect.sx,
      cropRect.sy,
      cropRect.sw,
      cropRect.sh,
      0,
      0,
      captureCanvas.width,
      captureCanvas.height
    );
  }

  function drawCroppedFrameLoop() {
    drawCroppedFrameOnce();
    drawLoopId = requestAnimationFrame(drawCroppedFrameLoop);
  }

  function beginMediaRecorder(stream) {
    mimeType = pickSupportedRecordingMimeType();
    if (!mimeType) throw new Error("이 브라우저는 화면 녹화를 지원하지 않습니다.");
    chunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.start(1000); // 1초 단위로 데이터를 모아서, 너무 늦게까지 안 모이는 걸 방지
  }

  function cleanupCaptureCanvas() {
    if (drawLoopId) {
      cancelAnimationFrame(drawLoopId);
      drawLoopId = null;
    }
    lockedTrack = null;
    captureCanvas = null;
    captureCtx = null;
  }

  return {
    isSupported() {
      return !!pickSupportedRecordingMimeType() && typeof canvas.captureStream === "function";
    },

    isLockedFrameSupported() {
      // captureStream(0)이 만드는 트랙은 CanvasCaptureMediaStreamTrack이고, requestFrame()은
      // 거기에만 있다(일반 MediaStreamTrack.prototype에는 없다).
      return (
        this.isSupported() &&
        typeof window.CanvasCaptureMediaStreamTrack !== "undefined" &&
        "requestFrame" in window.CanvasCaptureMediaStreamTrack.prototype
      );
    },

    isRecording() {
      return !!mediaRecorder && mediaRecorder.state === "recording";
    },

    // 실시간(화면에 보이는 대로) 녹화 — 매 프레임 자동으로 캡처한다.
    start() {
      setupCaptureCanvas();
      drawCroppedFrameLoop();
      beginMediaRecorder(captureCanvas.captureStream(30));
    },

    // 고정 프레임 녹화 — 프레임을 자동으로 찍지 않고, captureFrame()을 부를 때만 그 시점의
    // 화면을 한 장 기록한다. 드론 직선뷰처럼 진행을 실제 시간과 무관하게 고정된 간격으로 직접
    // 몰아서 구동할 수 있을 때, 렌더링이 잠깐 버벅여도(3D 타일 로딩 등) 영상에는 항상 일정한
    // 속도로만 진행된 것처럼 저장하기 위해 쓴다.
    startLocked() {
      setupCaptureCanvas();
      const stream = captureCanvas.captureStream(0); // 0 = 자동 캡처 없음, requestFrame()으로만 프레임 추가
      lockedTrack = stream.getVideoTracks()[0];
      beginMediaRecorder(stream);
    },

    // startLocked() 이후, 지금 화면 상태를 프레임 한 장으로 기록한다.
    captureFrame() {
      if (!lockedTrack) return;
      drawCroppedFrameOnce();
      lockedTrack.requestFrame();
    },

    // 녹화를 멈추고 완성된 Blob과 실제 확장자를 돌려준다.
    stop() {
      return new Promise((resolve, reject) => {
        if (!mediaRecorder) {
          reject(new Error("녹화 중이 아닙니다."));
          return;
        }
        mediaRecorder.onstop = () => {
          cleanupCaptureCanvas();
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

function downloadBlob(blob, suggestedName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Blob을 파일로 저장한다. File System Access API를 지원하는 브라우저(Chrome/Edge)에서는
// 파일명과 저장 폴더를 직접 고르는 네이티브 저장 대화상자를 띄우고, 지원하지 않거나 실패하면
// 기본 다운로드 폴더로 저장하는 방식으로 대체한다(그 경우 폴더 지정은 불가).
async function saveBlobAsFile(blob, suggestedName) {
  if (typeof window.showSaveFilePicker === "function") {
    const ext = suggestedName.split(".").pop();
    // accept의 키는 파라미터 없는 순수 MIME 타입이어야 한다(예: "video/mp4;codecs=avc1"처럼
    // 코덱 파라미터가 붙은 값을 넘기면 File System Access API가 거부하고 저장이 실패한다).
    // blob.type에서 파라미터만 떼어내 쓰면 영상이든 이미지든 다 이 함수 하나로 저장할 수 있다.
    const baseMimeType = (blob.type || "").split(";")[0] || (ext === "mp4" ? "video/mp4" : "video/webm");
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: ext.toUpperCase() + " 파일",
            accept: { [baseMimeType]: ["." + ext] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return "picker";
    } catch (err) {
      if (err.name === "AbortError") throw err; // 사용자가 저장 대화상자를 취소한 경우
      console.warn("showSaveFilePicker 저장 실패, 기본 다운로드로 대체합니다:", err);
      // 그 외 오류는 기본 다운로드로 대체 저장한다.
    }
  }

  downloadBlob(blob, suggestedName);
  return "download";
}
