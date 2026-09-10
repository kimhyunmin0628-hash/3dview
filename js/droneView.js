// 드론뷰: 전체보기(오버뷰) 화면에서 두 가지 방식으로 가상 드론 비행 경로를 만들고 재생한다.
//
// - 직선뷰: 지도에서 시작점 -> 끝점을 클릭하면, 그 사이를 직선으로 이동하며 진행 방향(정면)을
//   바라본다.
// - 회전뷰: 지도를 드래그해서 원/타원을 그리면 그 경로(궤도)가 정해지고, 이어서 중심으로 바라볼
//   지점을 클릭하면 그 지점을 항상 바라보며 궤도를 한 바퀴 돈다.
//
// 그리기는 지도(Cesium) 캔버스 위에 얹은 투명 오버레이 <canvas>(#drone-overlay)에서 처리한다.
// - 평소에는 pointer-events:none이라 지도 조작을 그대로 통과시키고,
// - 입력을 기다리는 단계(line-start/line-end/orbit-draw/orbit-center)에서만 auto로 바뀐다.
// 화면 좌표 -> 지면 좌표 변환은 camera.pickEllipsoid로 하고(건물 유무와 무관하게 항상 값이 나옴),
// 실제 비행 고도는 그 지점의 지반고(sampleGroundHeight) + 사용자가 슬라이더로 지정한 고도로 계산한다.

const DRONE_DEFAULT_LINE_ALTITUDE_M = 80; // 직선뷰 시작점/끝점의 기본 고도. 사용자가 각각 조절 가능
const DRONE_DEFAULT_ORBIT_ALTITUDE_M = 80; // 회전뷰 궤도(원/타원)의 기본 고도. 사용자가 조절 가능
const DRONE_DEFAULT_LOOKAT_ALTITUDE_M = 20; // 회전뷰가 바라보는 중심점의 기본 고도. 사용자가 조절 가능
const DRONE_PITCH_DEG = -8; // 직선뷰의 기본(정면 살짝 아래) 시선
const DRONE_MIN_DRAG_PX = 10; // 회전뷰 원/타원을 그릴 때 최소 드래그 크기(너무 작으면 취소)
const DRONE_ORBIT_SAMPLES = 64; // 궤도(원/타원)를 근사할 점 개수
const DRONE_DEFAULT_SPEED_MPS = 15;

function vec3Lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

// 입력을 기다리는 동안 오버레이가 마우스를 가로채야 하는 단계들.
const DRONE_INPUT_MODES = ["line-start", "line-end", "orbit-draw", "orbit-center"];

function createDroneView(viewer, overlayCanvas, callbacks) {
  let mode = "idle";
  // idle -> choosing -> (line-start -> line-end) | (orbit-draw -> orbit-center) -> ready -> playing

  let lookMode = "forward"; // 재생 시 시선 계산 방식: "forward"(진행방향) | "center"(고정 지점 응시)
  let groundPoints = []; // 직선뷰: [시작점, 끝점] / 회전뷰: 궤도를 근사하는 점들 ({lon,lat})
  let flightPath = []; // 고도 적용된 Cartesian3 목록
  let cumulative = []; // flightPath와 짝을 이루는 누적 거리(m)
  let lookAtCartesian = null; // 회전뷰가 항상 바라보는 좌표

  // 회전뷰 그리기 중간 상태
  let dragStartScreen = null;
  let dragStartGeo = null;
  let pendingSemiLon = 0; // 드래그로 정한 궤도의 동서 반지름(도)
  let pendingSemiLat = 0; // 드래그로 정한 궤도의 남북 반지름(도)
  let pendingRadiusPx = null; // 위와 짝을 이루는 화면 픽셀 반지름({rx,ry}) - 가운데 점에 재중심 미리보기용
  let lineScreenPoints = []; // 직선뷰 시작/끝점의 화면 좌표(경로 선을 그려서 보여주기 위한 용도)

  let lineStartAltitudeM = DRONE_DEFAULT_LINE_ALTITUDE_M; // 직선뷰 시작점의 고도(지면 위, m)
  let lineEndAltitudeM = DRONE_DEFAULT_LINE_ALTITUDE_M; // 직선뷰 끝점의 고도(지면 위, m)
  let orbitAltitudeM = DRONE_DEFAULT_ORBIT_ALTITUDE_M; // 회전뷰 궤도의 고도(지면 위, m)
  let lookAtAltitudeM = DRONE_DEFAULT_LOOKAT_ALTITUDE_M; // 회전뷰 중심점의 고도(지면 위, m)

  let speedMps = DRONE_DEFAULT_SPEED_MPS;
  let traveled = 0;
  let lastFrameTime = null;
  let rafId = null;

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

  function drawEllipseAt(cx, cy, rx, ry) {
    const ctx = overlayCanvas.getContext("2d");
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 드래그 중 미리보기: 드래그한 사각 범위에 딱 맞는 타원을 그린다.
  function drawEllipsePreview(a, b) {
    clearOverlayCanvas();
    drawEllipseAt((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(a.x - b.x) / 2, Math.abs(a.y - b.y) / 2);
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
    lookAtCartesian = null;
    lookMode = "forward";
  }

  // 궤도의 중심은 드래그로 그린 타원 자체의 중심이 아니라, 나중에 클릭하는 "가운데 점"(lookAtGeo)이다.
  // 드래그는 궤도의 크기(반지름)만 정하고, 실제 원/타원은 항상 그 가운데 점을 고르게 감싸도록
  // 다시 그 점을 중심으로 그린다. (드래그 중심과 가운데 점이 다르면 한쪽으로 치우친 궤도가 되어버림)
  function buildOrbitFlightPath(semiLonDeg, semiLatDeg, lookAtGeo) {
    const ringPoints = [];
    for (let i = 0; i <= DRONE_ORBIT_SAMPLES; i++) {
      const theta = (i / DRONE_ORBIT_SAMPLES) * Math.PI * 2;
      ringPoints.push({
        lon: lookAtGeo.lon + semiLonDeg * Math.cos(theta),
        lat: lookAtGeo.lat + semiLatDeg * Math.sin(theta),
      });
    }
    flightPath = ringPoints.map((p) => {
      const groundHeight = Math.max(0, sampleGroundHeight(viewer, p.lon, p.lat));
      return geodeticToCartesian(viewer, p.lon, p.lat, groundHeight + orbitAltitudeM);
    });
    buildCumulative();

    const targetGroundHeight = Math.max(0, sampleGroundHeight(viewer, lookAtGeo.lon, lookAtGeo.lat));
    lookAtCartesian = geodeticToCartesian(viewer, lookAtGeo.lon, lookAtGeo.lat, targetGroundHeight + lookAtAltitudeM);
    lookMode = "center";
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

  function computeOrientation(position, from, to) {
    if (lookMode === "center" && lookAtCartesian) {
      const camGeo = cartesianToGeodetic(viewer, position);
      const targetGeo = cartesianToGeodetic(viewer, lookAtCartesian);
      const headingDeg = bearingDegrees(camGeo.lon, camGeo.lat, targetGeo.lon, targetGeo.lat);
      const dist3D = vec3Distance(position, lookAtCartesian);
      const heightDiff = camGeo.height - targetGeo.height;
      const horizDist = Math.sqrt(Math.max(1, dist3D * dist3D - heightDiff * heightDiff));
      const pitchDeg = -toDeg(Math.atan2(heightDiff, horizDist));
      return { headingDeg, pitchDeg };
    }
    const fromGeo = cartesianToGeodetic(viewer, from);
    const toGeo = cartesianToGeodetic(viewer, to);
    return { headingDeg: bearingDegrees(fromGeo.lon, fromGeo.lat, toGeo.lon, toGeo.lat), pitchDeg: DRONE_PITCH_DEG };
  }

  function tick(now) {
    if (mode !== "playing") return;
    if (lastFrameTime == null) lastFrameTime = now;
    const dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    traveled += speedMps * dt;

    const { position, from, to, atEnd } = stateAtDistance(traveled);
    const { headingDeg, pitchDeg } = computeOrientation(position, from, to);

    viewer.camera.setView({
      destination: position,
      orientation: { heading: toRad(headingDeg), pitch: toRad(pitchDeg), roll: 0 },
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
    dragStartScreen = null;
    dragStartGeo = null;
    pendingSemiLon = 0;
    pendingSemiLat = 0;
    pendingRadiusPx = null;
    lineScreenPoints = [];
    clearOverlayCanvas();
  }

  function handlePointerDown(e) {
    if (mode === "orbit-draw") {
      const pt = canvasPointFromEvent(e);
      dragStartScreen = pt;
      dragStartGeo = projectToGround(pt);
      overlayCanvas.setPointerCapture(e.pointerId);
    }
  }

  function handlePointerMove(e) {
    if (mode === "orbit-draw" && dragStartScreen) {
      drawEllipsePreview(dragStartScreen, canvasPointFromEvent(e));
    }
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

    if (mode === "orbit-draw") {
      if (!dragStartScreen) return;
      const dx = pt.x - dragStartScreen.x;
      const dy = pt.y - dragStartScreen.y;
      const geo = projectToGround(pt);
      if (dx * dx + dy * dy < DRONE_MIN_DRAG_PX * DRONE_MIN_DRAG_PX || !dragStartGeo || !geo) {
        dragStartScreen = null;
        dragStartGeo = null;
        clearOverlayCanvas();
        if (callbacks.onTooShort) callbacks.onTooShort();
        return;
      }
      // 드래그는 궤도의 "크기"만 정한다(반지름). 실제 중심은 다음 단계에서 클릭하는 가운데 점이다.
      pendingSemiLon = Math.abs(dragStartGeo.lon - geo.lon) / 2;
      pendingSemiLat = Math.abs(dragStartGeo.lat - geo.lat) / 2;
      pendingRadiusPx = { rx: Math.abs(dx) / 2, ry: Math.abs(dy) / 2 };
      dragStartScreen = null;
      dragStartGeo = null;
      setMode("orbit-center");
      return;
    }

    if (mode === "orbit-center") {
      const geo = projectToGround(pt);
      if (!geo) return;
      buildOrbitFlightPath(pendingSemiLon, pendingSemiLat, geo);
      // 궤도를 클릭한 가운데 점 기준으로 다시 그려서, 실제로 날아갈 모양을 정확히 보여준다.
      clearOverlayCanvas();
      if (pendingRadiusPx) drawEllipseAt(pt.x, pt.y, pendingRadiusPx.rx, pendingRadiusPx.ry);
      drawMarker(pt);
      setMode("ready");
      return;
    }
  }

  return {
    // "드론뷰" 토글: 직선뷰/회전뷰 중 하나를 고르는 단계로 들어간다.
    startChoosing() {
      cancelAnimationFrame(rafId);
      lastFrameTime = null;
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

    chooseOrbit() {
      resetDrawingState();
      setMode("orbit-draw");
    },

    play() {
      if (mode !== "ready" && mode !== "playing") return;
      if (flightPath.length < 2) return;
      if (mode === "ready" && traveled >= cumulative[cumulative.length - 1]) {
        traveled = 0; // 끝까지 다 봤으면 처음부터 다시 재생
      }
      // 설정 단계에 그려둔 경로선(직선/타원)은 카메라가 움직이기 시작하면 화면과 안 맞으니 지운다.
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

    // 회전뷰를 확정(orbit-center 클릭)하는 시점에 읽어가는 값들. 그 전까지는 슬라이더로
    // 자유롭게 바꿀 수 있다.
    setOrbitAltitude(m) {
      orbitAltitudeM = Math.max(1, m);
    },

    setLookAtAltitude(m) {
      lookAtAltitudeM = Math.max(0, m);
    },

    exit() {
      cancelAnimationFrame(rafId);
      lastFrameTime = null;
      resetDrawingState();
      flightPath = [];
      cumulative = [];
      traveled = 0;
      lookAtCartesian = null;
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
