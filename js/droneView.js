// 드론뷰: 전체보기(오버뷰) 화면에서 두 가지 방식으로 가상 드론 촬영을 한다.
//
// - 직선뷰: 몇 개 지점(2~5개)을 지나는 경로로 촬영할지 먼저 고른다. 그 다음 각 지점마다
//   "고도를 정한다 -> (확정) -> 지도에서 그 지점을 클릭한다"를 순서대로 반복해서 경로를
//   완성하면, 그 지점들을 순서대로 지나며 진행 방향(정면)을 바라보는 비행 경로가 된다.
// - 드론수동조정: 키보드로 직접 드론을 조종하면서 촬영한다(조작법은 index.html의 안내 참고).
//
// 직선뷰 그리기는 지도(Cesium) 캔버스 위에 얹은 투명 오버레이 <canvas>(#drone-overlay)에서
// 처리한다. 평소에는 pointer-events:none이라 지도 조작을 그대로 통과시키고, 지점 클릭을
// 기다리는 단계(line-pick)에서만 auto로 바뀐다(고도를 정하는 단계에서는 아직 지도를 클릭할 수
// 없다). 화면 좌표 -> 지면 좌표 변환은 camera.pickEllipsoid로 하고(건물 유무와 무관하게 항상
// 값이 나옴), 실제 비행 고도는 그 지점의 지반고(sampleGroundHeight) + 사용자가 그 지점에서
// 슬라이더로 지정한 고도로 계산한다.

const DRONE_DEFAULT_LINE_ALTITUDE_M = 80; // 직선뷰 각 지점의 기본 고도. 지점마다 따로 조절 가능
const DRONE_PITCH_DEG = -8; // 직선뷰의 기본(정면 살짝 아래) 시선
const DRONE_DEFAULT_SPEED_MPS = 15;
const LINE_POINT_COUNT_MIN = 2;
const LINE_POINT_COUNT_MAX = 5;

// 드론수동조정 설정
// 화면 = 드론 카메라 시야라고 생각하고 설계한다: 방향키는 지금 보고 있는 방향 기준으로
// 전진/후진/좌우 이동(스트레이프)하고, Shift+방향키로 그 "보고 있는 방향" 자체를 돌린다.
// W/S(상승/하강)와 완전히 같은 방식(누르는 동안 그 속도, 떼면 즉시 0)으로 통일해서
// 방향키만 뻣뻣하게 느껴지던 문제를 없앤다.
const MANUAL_DEFAULT_SPEED_MPS = 12; // 전진/후진/좌우이동/상승/하강 공통 속도
const MANUAL_LOOK_RATE_DEG_PER_S = 29.4; // Shift+방향키로 시야를 돌리는 속도 (기존 70의 60% -> 다시 70%)
const MANUAL_PITCH_MIN_DEG = -85;
const MANUAL_PITCH_MAX_DEG = 60;
const MANUAL_MIN_HEIGHT_M = 1;

function vec3Lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

// 입력을 기다리는 동안 오버레이가 마우스를 가로채야 하는 단계들(직선뷰 지점 클릭).
const DRONE_INPUT_MODES = ["line-pick"];

function createDroneView(viewer, overlayCanvas, callbacks) {
  let mode = "idle";
  // idle -> choosing -> line-count -> (line-altitude -> line-pick)*N -> ready -> playing | manual

  let groundPoints = []; // 직선뷰 지금까지 확정한 지점들 ({lon,lat}[])
  let flightPath = []; // 고도 적용된 Cartesian3 목록
  let cumulative = []; // flightPath와 짝을 이루는 누적 거리(m)
  let lineScreenPoints = []; // 직선뷰 확정한 지점들의 화면 좌표(경로 선을 그려서 보여주기 위한 용도)

  let linePointCount = 0; // 이번 직선뷰에서 찍을 총 지점 수(2~5). 아직 안 골랐으면 0
  let linePointAltitudesM = []; // 지점별 고도(지면 위, m). 길이 = linePointCount
  let currentLinePointIndex = 0; // 지금 고도를 정하고 있거나(line-altitude)/클릭을 기다리는(line-pick) 지점의 0-based 인덱스

  let speedMps = DRONE_DEFAULT_SPEED_MPS;
  let traveled = 0;
  let lastFrameTime = null;
  let rafId = null;

  // 드론수동조정 상태. heading/pitch는 곧 "화면이 보고 있는 방향"이고, 전진/후진/좌우이동은
  // 항상 이 방향을 기준으로 한다(따로 기체 방향과 카메라 방향을 분리하지 않는다).
  let manualPosition = null; // Cartesian3
  let manualHeadingDeg = 0;
  let manualPitchDeg = -10;
  let manualSpeedMps = MANUAL_DEFAULT_SPEED_MPS;
  let manualKeys = {
    forward: false,
    backward: false,
    strafeLeft: false,
    strafeRight: false,
    lookUp: false,
    lookDown: false,
    lookLeft: false,
    lookRight: false,
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

  // 지금까지 확정한 지점들을 순서대로 잇는 선을 그려서 경로를 눈으로 보이게 한다.
  // play()가 시작되면(카메라가 움직이기 시작하면) 더 이상 화면과 안 맞으므로 그때 지운다.
  function drawPath(points) {
    clearOverlayCanvas();
    if (points.length === 0) return;
    if (points.length > 1) {
      const ctx = overlayCanvas.getContext("2d");
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
    }
    points.forEach((p) => drawMarker(p));
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
    // 지점마다 각자 다른 고도를 줄 수 있어서, 인접한 두 지점의 고도가 다르면 그 구간은
    // 상승/하강하며 이동하는 경로가 된다.
    flightPath = groundPoints.map((p, i) => {
      const groundHeight = Math.max(0, sampleGroundHeight(viewer, p.lon, p.lat));
      const altitude = linePointAltitudesM[i] != null ? linePointAltitudesM[i] : DRONE_DEFAULT_LINE_ALTITUDE_M;
      return geodeticToCartesian(viewer, p.lon, p.lat, groundHeight + altitude);
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
    linePointCount = 0;
    linePointAltitudesM = [];
    currentLinePointIndex = 0;
    clearOverlayCanvas();
  }

  function handlePointerDown() {
    // 직선뷰는 클릭 한 번(pointerdown+pointerup)으로 점을 찍으므로 down에서 할 일은 없다.
  }

  function handlePointerMove() {
    // 직선뷰는 드래그 미리보기가 필요 없다.
  }

  function handlePointerUp(e) {
    if (mode !== "line-pick") return;
    const pt = canvasPointFromEvent(e);
    const geo = projectToGround(pt);
    if (!geo) return;

    groundPoints.push(geo);
    lineScreenPoints.push(pt);
    drawPath(lineScreenPoints);

    if (groundPoints.length < linePointCount) {
      // 다음 지점의 고도부터 다시 정한다.
      currentLinePointIndex = groundPoints.length;
      setMode("line-altitude");
    } else {
      buildLineFlightPath();
      drawPath(lineScreenPoints); // 재생 전까지는 경로를 선으로 보여준다
      setMode("ready");
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

    // Shift+방향키: 화면(시야) 방향 자체를 돌린다. 즉시 반응(누르는 동안 그 속도).
    if (manualKeys.lookLeft) manualHeadingDeg -= MANUAL_LOOK_RATE_DEG_PER_S * dt;
    if (manualKeys.lookRight) manualHeadingDeg += MANUAL_LOOK_RATE_DEG_PER_S * dt;
    manualHeadingDeg = ((manualHeadingDeg % 360) + 360) % 360;
    if (manualKeys.lookUp) manualPitchDeg = Math.min(MANUAL_PITCH_MAX_DEG, manualPitchDeg + MANUAL_LOOK_RATE_DEG_PER_S * dt);
    if (manualKeys.lookDown) manualPitchDeg = Math.max(MANUAL_PITCH_MIN_DEG, manualPitchDeg - MANUAL_LOOK_RATE_DEG_PER_S * dt);

    // 방향키: 지금 화면이 보고 있는 방향(manualHeadingDeg) 기준으로 전진/후진/좌우이동.
    // W/S(상승/하강)와 완전히 같은 방식 — 누르는 동안 그 속도로, 떼면 즉시 0.
    const forwardDir = (manualKeys.forward ? 1 : 0) - (manualKeys.backward ? 1 : 0);
    const strafeDir = (manualKeys.strafeRight ? 1 : 0) - (manualKeys.strafeLeft ? 1 : 0);
    const vertDir = (manualKeys.up ? 1 : 0) - (manualKeys.down ? 1 : 0);

    if (forwardDir !== 0 || strafeDir !== 0 || vertDir !== 0) {
      const headingRad = toRad(manualHeadingDeg);
      const rightRad = headingRad + Math.PI / 2; // 화면이 보는 방향의 오른쪽(스트레이프 방향)
      const geo = cartesianToGeodetic(viewer, manualPosition);
      const fwdDist = manualSpeedMps * dt * forwardDir;
      const strafeDist = manualSpeedMps * dt * strafeDir;
      const dNorth = fwdDist * Math.cos(headingRad) + strafeDist * Math.cos(rightRad);
      const dEast = fwdDist * Math.sin(headingRad) + strafeDist * Math.sin(rightRad);
      const dLat = dNorth / METERS_PER_DEGREE_LAT;
      const dLon = dEast / (METERS_PER_DEGREE_LAT * Math.cos(toRad(geo.lat)));
      const newHeight = Math.max(MANUAL_MIN_HEIGHT_M, geo.height + manualSpeedMps * dt * vertDir);
      manualPosition = geodeticToCartesian(viewer, geo.lon + dLon, geo.lat + dLat, newHeight);
    }

    viewer.camera.setView({
      destination: manualPosition,
      orientation: { heading: toRad(manualHeadingDeg), pitch: toRad(manualPitchDeg), roll: 0 },
    });
  }

  function handleManualKeyDown(e) {
    if (mode !== "manual") return;
    let handled = true;
    switch (e.code) {
      case "ArrowUp":
        if (e.shiftKey) manualKeys.lookUp = true;
        else manualKeys.forward = true;
        break;
      case "ArrowDown":
        if (e.shiftKey) manualKeys.lookDown = true;
        else manualKeys.backward = true;
        break;
      case "ArrowLeft":
        if (e.shiftKey) manualKeys.lookLeft = true;
        else manualKeys.strafeLeft = true;
        break;
      case "ArrowRight":
        if (e.shiftKey) manualKeys.lookRight = true;
        else manualKeys.strafeRight = true;
        break;
      case "KeyW":
        manualKeys.up = true;
        break;
      case "KeyS":
        manualKeys.down = true;
        break;
      case "Space":
        resetManualKeys(); // 정지: 눌려있던 모든 이동 키를 초기화해서 즉시 제자리에 호버링한다.
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      // vworld/Cesium이 방향키에 대해 자체 키보드 핸들러를 갖고 있어서(마우스 컨트롤을 끄는
      // enableInputs로는 못 막음), 그게 같은 이벤트에 반응해 카메라를 한 프레임 툭 건드리는
      // "화면이 튀는" 현상이 있었다. 캡처 단계에서 여기서 완전히 멈춰서 vworld의 리스너까지
      // 이벤트가 도달하지 못하게 한다.
      e.stopPropagation();
    }
  }

  function handleManualKeyUp(e) {
    if (mode !== "manual") return;
    let handled = true;
    switch (e.code) {
      case "ArrowUp":
        manualKeys.lookUp = false;
        manualKeys.forward = false;
        break;
      case "ArrowDown":
        manualKeys.lookDown = false;
        manualKeys.backward = false;
        break;
      case "ArrowLeft":
        manualKeys.lookLeft = false;
        manualKeys.strafeLeft = false;
        break;
      case "ArrowRight":
        manualKeys.lookRight = false;
        manualKeys.strafeRight = false;
        break;
      case "KeyW":
        manualKeys.up = false;
        break;
      case "KeyS":
        manualKeys.down = false;
        break;
      default:
        handled = false;
    }
    if (handled) e.stopPropagation();
  }

  // 캡처 단계(true)로 등록해야, window에 등록됐을 vworld/Cesium 자체의 키보드 핸들러(버블 단계)보다
  // 먼저 이벤트를 받아서 stopPropagation으로 거기까지 도달하지 못하게 막을 수 있다.
  window.addEventListener("keydown", handleManualKeyDown, true);
  window.addEventListener("keyup", handleManualKeyUp, true);

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

    // "직선뷰" 선택: 몇 개 지점을 지나는 경로로 찍을지부터 고르는 단계로 들어간다.
    chooseLineCount() {
      resetDrawingState();
      setMode("line-count");
    },

    // 지점 개수(2~5)를 확정하고, 첫 번째 지점의 고도를 정하는 단계로 넘어간다.
    setLinePointCount(n) {
      const count = Math.max(LINE_POINT_COUNT_MIN, Math.min(LINE_POINT_COUNT_MAX, Math.round(n)));
      linePointCount = count;
      linePointAltitudesM = new Array(count).fill(DRONE_DEFAULT_LINE_ALTITUDE_M);
      currentLinePointIndex = 0;
      setMode("line-altitude");
    },

    // 지금 정하고 있는 지점(currentLinePointIndex)의 고도를 확정하고, 지도에서 그 지점을
    // 클릭할 수 있는 단계(line-pick)로 넘어간다.
    confirmLinePointAltitude() {
      if (mode !== "line-altitude") return;
      setMode("line-pick");
    },

    // 현재 보고 있는 화면 그대로에서 수동 조종을 시작한다(위치/방향을 이어받음).
    chooseManual() {
      resetDrawingState();
      const cam = viewer.camera;
      manualPosition = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
      manualHeadingDeg = toDeg(cam.heading);
      manualPitchDeg = Math.max(MANUAL_PITCH_MIN_DEG, Math.min(MANUAL_PITCH_MAX_DEG, toDeg(cam.pitch)));
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

    // 지금 정하고 있는 지점의 고도(슬라이더 조작 중 실시간으로 반영).
    setLinePointAltitude(m) {
      if (linePointCount === 0) return;
      linePointAltitudesM[currentLinePointIndex] = Math.max(1, m);
    },

    // 지금 정하고 있는/클릭을 기다리는 지점의 0-based 인덱스와, 이번에 찍을 총 지점 수.
    // UI가 "N번째 지점" 같은 안내 문구를 만들 때 쓴다.
    getLinePointIndex() {
      return currentLinePointIndex;
    },

    getLinePointCount() {
      return linePointCount;
    },

    getCurrentLinePointAltitude() {
      return linePointAltitudesM[currentLinePointIndex] != null
        ? linePointAltitudesM[currentLinePointIndex]
        : DRONE_DEFAULT_LINE_ALTITUDE_M;
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

    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    resizeOverlay,
  };
}
