// 드론뷰: 전체보기(오버뷰) 화면에서 두 가지 방식으로 가상 드론 촬영을 한다.
//
// - 직선뷰: 시작점 고도를 먼저 정하고 시작점을 클릭 -> 끝점 고도를 정하고 끝점을 클릭하면,
//   그 사이를 직선으로 이동하며 진행 방향(정면)을 바라본다.
// - 드론수동조정: 키보드로 직접 드론을 조종하면서 촬영한다(아래 KEY_HELP_TEXT 참고).
//
// 직선뷰 그리기는 지도(Cesium) 캔버스 위에 얹은 투명 오버레이 <canvas>(#drone-overlay)에서
// 처리한다. 평소에는 pointer-events:none이라 지도 조작을 그대로 통과시키고, 입력을 기다리는
// 단계(line-start/line-end)에서만 auto로 바뀐다. 화면 좌표 -> 지면 좌표 변환은
// camera.pickEllipsoid로 하고(건물 유무와 무관하게 항상 값이 나옴), 실제 비행 고도는 그 지점의
// 지반고(sampleGroundHeight) + 사용자가 슬라이더로 지정한 고도로 계산한다.

const DRONE_DEFAULT_LINE_ALTITUDE_M = 80; // 직선뷰 시작점/끝점의 기본 고도. 사용자가 각각 조절 가능
const DRONE_PITCH_DEG = -8; // 직선뷰의 기본(정면 살짝 아래) 시선
const DRONE_DEFAULT_SPEED_MPS = 15;

// 드론수동조정 설정
const MANUAL_DEFAULT_SPEED_MPS = 12;
const MANUAL_TURN_RATE_DEG_PER_S = 60; // 기체 좌우 회전 속도
const MANUAL_CAM_RATE_DEG_PER_S = 70; // 카메라(짐벌) 좌우/상하 속도
const MANUAL_PITCH_MIN_DEG = -85;
const MANUAL_PITCH_MAX_DEG = 60;
const MANUAL_MIN_HEIGHT_M = 1;

const KEY_HELP_TEXT =
  "방향키: 드론 이동/회전 · Shift+방향키: 카메라 · W/S: 상승/하강 · Space: 정지";

function vec3Lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

// 입력을 기다리는 동안 오버레이가 마우스를 가로채야 하는 단계들(직선뷰 두 점 클릭).
const DRONE_INPUT_MODES = ["line-start", "line-end"];

function createDroneView(viewer, overlayCanvas, callbacks) {
  let mode = "idle";
  // idle -> choosing -> (line-start -> line-end -> ready -> playing) | manual

  let groundPoints = []; // 직선뷰 [시작점, 끝점] ({lon,lat})
  let flightPath = []; // 고도 적용된 Cartesian3 목록
  let cumulative = []; // flightPath와 짝을 이루는 누적 거리(m)
  let lineScreenPoints = []; // 직선뷰 시작/끝점의 화면 좌표(경로 선을 그려서 보여주기 위한 용도)

  let lineStartAltitudeM = DRONE_DEFAULT_LINE_ALTITUDE_M; // 직선뷰 시작점의 고도(지면 위, m)
  let lineEndAltitudeM = DRONE_DEFAULT_LINE_ALTITUDE_M; // 직선뷰 끝점의 고도(지면 위, m)

  let speedMps = DRONE_DEFAULT_SPEED_MPS;
  let traveled = 0;
  let lastFrameTime = null;
  let rafId = null;

  // 드론수동조정 상태
  let manualPosition = null; // Cartesian3
  let manualBodyHeadingDeg = 0; // 기체가 바라보는(=전진 방향) 방위
  let manualCamYawOffsetDeg = 0; // 기체 방향 기준 카메라(짐벌)의 좌우 오프셋
  let manualCamPitchDeg = -10;
  let manualSpeedMps = MANUAL_DEFAULT_SPEED_MPS;
  let manualKeys = {
    forward: false,
    backward: false,
    turnLeft: false,
    turnRight: false,
    camUp: false,
    camDown: false,
    camLeft: false,
    camRight: false,
    up: false,
    down: false,
  };
  let manualLastFrameTime = null;
  let removeManualPostRender = null;

  function setMode(next) {
    mode = next;
    if (callbacks.onModeChange) callbacks.onModeChange(mode);
  }

  function resizeOverlay() {
    overlayCanvas.width = viewer.scene.canvas.clientWidth;
    overlayCanvas.height = viewer.scene.canvas.clientHeight;
  }

  function clearOverlayCanvas() {
    overlayCanvas.getContext("2d").clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }

  function drawMarker(pt) {
    const ctx = overlayCanvas.getContext("2d");
    ctx.fillStyle = "#3b82f6";
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // 직선뷰의 시작점 -> 끝점을 잇는 선을 그려서 경로를 눈으로 보이게 한다.
  // play()가 시작되면(카메라가 움직이기 시작하면) 더 이상 화면과 안 맞으므로 그때 지운다.
  function drawLine(a, b) {
    clearOverlayCanvas();
    const ctx = overlayCanvas.getContext("2d");
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    [a, b].forEach((p) => drawMarker(p));
  }

  function canvasPointFromEvent(e) {
    const rect = overlayCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function projectToGround(pt) {
    const cart = viewer.camera.pickEllipsoid(pt, viewer.scene.globe.ellipsoid);
    if (!cart) return null;
    return cartesianToGeodetic(viewer, cart);
  }

  function buildCumulative() {
    cumulative = [0];
    for (let i = 1; i < flightPath.length; i++) {
      cumulative.push(cumulative[i - 1] + vec3Distance(flightPath[i - 1], flightPath[i]));
    }
    traveled = 0;
  }

  function buildLineFlightPath() {
    // 시작점/끝점에 각자 다른 고도를 줄 수 있어서, 두 고도가 다르면 상승/하강하는 직선 경로가 된다.
    const altitudes = [lineStartAltitudeM, lineEndAltitudeM];
    flightPath = groundPoints.map((p, i) => {
      const groundHeight = Math.max(0, sampleGroundHeight(viewer, p.lon, p.lat));
      return geodeticToCartesian(viewer, p.lon, p.lat, groundHeight + altitudes[i]);
    });
    buildCumulative();
  }

  // 지금까지 이동한 거리(dist)에 해당하는 경로 위의 위치와, 그 구간의 진행방향(from->to)을 구한다.
  function stateAtDistance(dist) {
    const total = cumulative[cumulative.length - 1];
    const clamped = Math.max(0, Math.min(total, dist));
    let i = 1;
    while (i < cumulative.length - 1 && cumulative[i] < clamped) i++;
    const segStart = cumulative[i - 1];
    const segEnd = cumulative[i];
    const t = segEnd > segStart ? (clamped - segStart) / (segEnd - segStart) : 0;
    return {
      position: vec3Lerp(flightPath[i - 1], flightPath[i], t),
      from: flightPath[i - 1],
      to: flightPath[i],
      atEnd: clamped >= total,
    };
  }

  function tick(now) {
    if (mode !== "playing") return;
    if (lastFrameTime == null) lastFrameTime = now;
    const dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    traveled += speedMps * dt;

    const { position, from, to, atEnd } = stateAtDistance(traveled);
    const fromGeo = cartesianToGeodetic(viewer, from);
    const toGeo = cartesianToGeodetic(viewer, to);
    const headingDeg = bearingDegrees(fromGeo.lon, fromGeo.lat, toGeo.lon, toGeo.lat);

    viewer.camera.setView({
      destination: position,
      orientation: { heading: toRad(headingDeg), pitch: toRad(DRONE_PITCH_DEG), roll: 0 },
    });

    if (atEnd) {
      lastFrameTime = null;
      setMode("ready");
      if (callbacks.onFinished) callbacks.onFinished();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function resetDrawingState() {
    groundPoints = [];
    lineScreenPoints = [];
    clearOverlayCanvas();
  }

  function handlePointerDown() {
    // 직선뷰는 클릭 한 번(pointerdown+pointerup)으로 점을 찍으므로 down에서 할 일은 없다.
  }

  function handlePointerMove() {
    // 직선뷰는 드래그 미리보기가 필요 없다.
  }

  function handlePointerUp(e) {
    const pt = canvasPointFromEvent(e);

    if (mode === "line-start") {
      const geo = projectToGround(pt);
      if (!geo) return;
      groundPoints = [geo];
      lineScreenPoints = [pt];
      clearOverlayCanvas();
      drawMarker(pt);
      setMode("line-end");
      return;
    }

    if (mode === "line-end") {
      const geo = projectToGround(pt);
      if (!geo) return;
      groundPoints.push(geo);
      lineScreenPoints.push(pt);
      buildLineFlightPath();
      drawLine(lineScreenPoints[0], lineScreenPoints[1]); // 재생 전까지는 경로를 선으로 보여준다
      setMode("ready");
      return;
    }
  }

  // ---- 드론수동조정 ----

  function stopManualLoop() {
    if (removeManualPostRender) {
      removeManualPostRender();
      removeManualPostRender = null;
    }
    manualLastFrameTime = null;
  }

  function resetManualKeys() {
    Object.keys(manualKeys).forEach((k) => (manualKeys[k] = false));
  }

  function manualTick() {
    if (mode !== "manual") return;
    const now = performance.now();
    if (manualLastFrameTime == null) {
      manualLastFrameTime = now;
      return;
    }
    const dt = (now - manualLastFrameTime) / 1000;
    manualLastFrameTime = now;
    if (dt <= 0 || dt > 1) return; // 탭이 백그라운드에 있다가 돌아온 경우 등 비정상적으로 큰 dt는 무시

    if (manualKeys.turnLeft) manualBodyHeadingDeg -= MANUAL_TURN_RATE_DEG_PER_S * dt;
    if (manualKeys.turnRight) manualBodyHeadingDeg += MANUAL_TURN_RATE_DEG_PER_S * dt;
    manualBodyHeadingDeg = ((manualBodyHeadingDeg % 360) + 360) % 360;

    if (manualKeys.camLeft) manualCamYawOffsetDeg -= MANUAL_CAM_RATE_DEG_PER_S * dt;
    if (manualKeys.camRight) manualCamYawOffsetDeg += MANUAL_CAM_RATE_DEG_PER_S * dt;
    if (manualKeys.camUp) {
      manualCamPitchDeg = Math.min(MANUAL_PITCH_MAX_DEG, manualCamPitchDeg + MANUAL_CAM_RATE_DEG_PER_S * dt);
    }
    if (manualKeys.camDown) {
      manualCamPitchDeg = Math.max(MANUAL_PITCH_MIN_DEG, manualCamPitchDeg - MANUAL_CAM_RATE_DEG_PER_S * dt);
    }

    const moveDir = (manualKeys.forward ? 1 : 0) - (manualKeys.backward ? 1 : 0);
    const vertDir = (manualKeys.up ? 1 : 0) - (manualKeys.down ? 1 : 0);

    if (moveDir !== 0 || vertDir !== 0) {
      const headingRad = toRad(manualBodyHeadingDeg);
      const geo = cartesianToGeodetic(viewer, manualPosition);
      const distance = manualSpeedMps * dt * moveDir;
      const dLat = (distance * Math.cos(headingRad)) / METERS_PER_DEGREE_LAT;
      const dLon = (distance * Math.sin(headingRad)) / (METERS_PER_DEGREE_LAT * Math.cos(toRad(geo.lat)));
      const newHeight = Math.max(MANUAL_MIN_HEIGHT_M, geo.height + manualSpeedMps * dt * vertDir);
      manualPosition = geodeticToCartesian(viewer, geo.lon + dLon, geo.lat + dLat, newHeight);
    }

    const renderedHeadingDeg = manualBodyHeadingDeg + manualCamYawOffsetDeg;
    viewer.camera.setView({
      destination: manualPosition,
      orientation: { heading: toRad(renderedHeadingDeg), pitch: toRad(manualCamPitchDeg), roll: 0 },
    });
  }

  function handleManualKeyDown(e) {
    if (mode !== "manual") return;
    let handled = true;
    switch (e.code) {
      case "ArrowUp":
        if (e.shiftKey) manualKeys.camUp = true;
        else manualKeys.forward = true;
        break;
      case "ArrowDown":
        if (e.shiftKey) manualKeys.camDown = true;
        else manualKeys.backward = true;
        break;
      case "ArrowLeft":
        if (e.shiftKey) manualKeys.camLeft = true;
        else manualKeys.turnLeft = true;
        break;
      case "ArrowRight":
        if (e.shiftKey) manualKeys.camRight = true;
        else manualKeys.turnRight = true;
        break;
      case "KeyW":
        manualKeys.up = true;
        break;
      case "KeyS":
        manualKeys.down = true;
        break;
      case "Space":
        resetManualKeys(); // 정지: 눌려있던 모든 이동 키 상태를 초기화(제자리 호버링)
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }

  function handleManualKeyUp(e) {
    if (mode !== "manual") return;
    switch (e.code) {
      case "ArrowUp":
        manualKeys.camUp = false;
        manualKeys.forward = false;
        break;
      case "ArrowDown":
        manualKeys.camDown = false;
        manualKeys.backward = false;
        break;
      case "ArrowLeft":
        manualKeys.camLeft = false;
        manualKeys.turnLeft = false;
        break;
      case "ArrowRight":
        manualKeys.camRight = false;
        manualKeys.turnRight = false;
        break;
      case "KeyW":
        manualKeys.up = false;
        break;
      case "KeyS":
        manualKeys.down = false;
        break;
    }
  }

  window.addEventListener("keydown", handleManualKeyDown);
  window.addEventListener("keyup", handleManualKeyUp);

  return {
    // "드론뷰" 토글: 직선뷰/드론수동조정 중 하나를 고르는 단계로 들어간다.
    startChoosing() {
      cancelAnimationFrame(rafId);
      lastFrameTime = null;
      stopManualLoop();
      resetManualKeys();
      resetDrawingState();
      flightPath = [];
      cumulative = [];
      traveled = 0;
      resizeOverlay();
      setMode("choosing");
    },

    chooseLine() {
      resetDrawingState();
      setMode("line-start");
    },

    // 현재 보고 있는 화면 그대로에서 수동 조종을 시작한다(위치/방향을 이어받음).
    chooseManual() {
      resetDrawingState();
      const cam = viewer.camera;
      manualPosition = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
      manualBodyHeadingDeg = toDeg(cam.heading);
      manualCamYawOffsetDeg = 0;
      manualCamPitchDeg = Math.max(MANUAL_PITCH_MIN_DEG, Math.min(MANUAL_PITCH_MAX_DEG, toDeg(cam.pitch)));
      resetManualKeys();
      manualLastFrameTime = null;
      if (!removeManualPostRender) {
        removeManualPostRender = viewer.scene.postRender.addEventListener(manualTick);
      }
      setMode("manual");
    },

    play() {
      if (mode !== "ready" && mode !== "playing") return;
      if (flightPath.length < 2) return;
      if (mode === "ready" && traveled >= cumulative[cumulative.length - 1]) {
        traveled = 0; // 끝까지 다 봤으면 처음부터 다시 재생
      }
      // 설정 단계에 그려둔 경로선(직선)은 카메라가 움직이기 시작하면 화면과 안 맞으니 지운다.
      clearOverlayCanvas();
      lastFrameTime = null;
      setMode("playing");
      rafId = requestAnimationFrame(tick);
    },

    pause() {
      if (mode !== "playing") return;
      cancelAnimationFrame(rafId);
      lastFrameTime = null;
      setMode("ready");
    },

    setSpeed(mps) {
      speedMps = Math.max(1, mps);
    },

    // 직선뷰의 시작점/끝점을 클릭(확정)하는 시점에 읽어가는 값들.
    setLineStartAltitude(m) {
      lineStartAltitudeM = Math.max(1, m);
    },

    setLineEndAltitude(m) {
      lineEndAltitudeM = Math.max(1, m);
    },

    setManualSpeed(mps) {
      manualSpeedMps = Math.max(1, mps);
    },

    exit() {
      cancelAnimationFrame(rafId);
      lastFrameTime = null;
      stopManualLoop();
      resetManualKeys();
      resetDrawingState();
      flightPath = [];
      cumulative = [];
      traveled = 0;
      setMode("idle");
    },

    isActive() {
      return mode !== "idle";
    },

    isWaitingForInput() {
      return DRONE_INPUT_MODES.indexOf(mode) !== -1;
    },

    getMode() {
      return mode;
    },

    getKeyHelpText() {
      return KEY_HELP_TEXT;
    },

    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    resizeOverlay,
  };
}
