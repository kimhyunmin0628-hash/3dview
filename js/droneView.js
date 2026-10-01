// 드론뷰: 전체보기(오버뷰) 화면에서 키보드로 가상 드론을 직접 조종하며 촬영한다(드론수동조정).
// "드론뷰" 버튼을 누르면 바로 수동조정 모드로 들어간다(현재 보고 있는 위치/방향을 그대로
// 이어받음). 조작법은 index.html의 안내 참고.

// 드론수동조정 설정
// 화면 = 드론 카메라 시야라고 생각하고 설계한다: 방향키는 지금 보고 있는 방향 기준으로
// 전진/후진/좌우 이동(스트레이프)하고, W/S/A/D로 그 "보고 있는 방향" 자체(상하/좌우)를 돌리고,
// R/F로 상승/하강한다. 세 그룹이 전부 서로 다른 물리 키라서 실제 드론 조종기처럼 동시에
// 눌러도(예: 전진+좌회전+상승) 그대로 같이 반영된다. 세 그룹 모두 같은 방식(누르는 동안 그
// 속도, 떼면 즉시 0)으로 통일해서 어느 키만 뻣뻣하게 느껴지는 문제를 없앤다. 세 그룹의 속도는
// 서로 독립된 슬라이더로 각각 조절할 수 있다(main.js의 #drone-manual-speed/-look/-vertical).
const MANUAL_DEFAULT_SPEED_MPS = 12; // 전진/후진/좌우이동 속도
const MANUAL_DEFAULT_VERTICAL_SPEED_MPS = 12; // 상승/하강(R/F) 속도. 이동 속도와 같은 범위(2~100)를 쓴다
const MANUAL_LOOK_RATE_BASE_DEG_PER_S = 9.8; // 기존(조정 기능 추가 전) 시야전환 속도
const MANUAL_DEFAULT_LOOK_RATE_DEG_PER_S = 7.8; // 시야전환(WSAD) 기본 속도: 기존 속도의 약 80%
const MANUAL_PITCH_MIN_DEG = -85;
const MANUAL_PITCH_MAX_DEG = 60;
const MANUAL_MIN_HEIGHT_M = 1;

function createDroneView(viewer, callbacks) {
  let mode = "idle"; // idle -> manual

  // 드론수동조정 상태. heading/pitch는 곧 "화면이 보고 있는 방향"이고, 전진/후진/좌우이동은
  // 항상 이 방향을 기준으로 한다(따로 기체 방향과 카메라 방향을 분리하지 않는다).
  let manualPosition = null; // Cartesian3
  let manualHeadingDeg = 0;
  let manualPitchDeg = -10;
  let manualSpeedMps = MANUAL_DEFAULT_SPEED_MPS;
  let manualVerticalSpeedMps = MANUAL_DEFAULT_VERTICAL_SPEED_MPS;
  let manualLookRateDegPerS = MANUAL_DEFAULT_LOOK_RATE_DEG_PER_S;
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
  let manualInputRecordingStartPose = null; // 입력 녹화를 시작한 시점의 위치/시야(재생 시작점)

  function setMode(next) {
    mode = next;
    if (callbacks.onModeChange) callbacks.onModeChange(mode);
  }

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

  // 입력을 기록해뒀다가(고정 프레임 녹화용) 나중에 그대로 재생할 수 있게 해주는 기록기.
  const manualInputRecorder = createInputTimelineRecorder();

  // manualKeys의 한 항목을 바꾸면서, 입력 기록 중이면 그 변화도 타임라인에 남긴다. 실제로
  // 값이 바뀔 때만 기록해야 한다(키보드 auto-repeat으로 오는 중복 keydown은 무시).
  function setManualKey(name, pressed) {
    if (manualKeys[name] === pressed) return;
    manualKeys[name] = pressed;
    manualInputRecorder.logChange(name, pressed);
  }

  // dt(초) 동안 keys 상태를 기준으로 위치/시야를 전진시키고 카메라에 반영한다. 실시간 조작
  // (manualTick, 실제 dt)과 재생(고정 프레임 녹화, 고정 dt) 양쪽에서 그대로 재사용한다.
  function advanceManual(dt, keys) {
    // W/S/A/D: 화면(시야) 방향 자체를 돌린다. 즉시 반응(누르는 동안 그 속도).
    if (keys.lookLeft) manualHeadingDeg -= manualLookRateDegPerS * dt;
    if (keys.lookRight) manualHeadingDeg += manualLookRateDegPerS * dt;
    manualHeadingDeg = ((manualHeadingDeg % 360) + 360) % 360;
    if (keys.lookUp) manualPitchDeg = Math.min(MANUAL_PITCH_MAX_DEG, manualPitchDeg + manualLookRateDegPerS * dt);
    if (keys.lookDown) manualPitchDeg = Math.max(MANUAL_PITCH_MIN_DEG, manualPitchDeg - manualLookRateDegPerS * dt);

    // 방향키: 지금 화면이 보고 있는 방향(manualHeadingDeg) 기준으로 전진/후진/좌우이동.
    // R/F(상승/하강)와 같은 방식 — 누르는 동안 그 속도로, 떼면 즉시 0. 다만 속도는 서로 독립적이다.
    const forwardDir = (keys.forward ? 1 : 0) - (keys.backward ? 1 : 0);
    const strafeDir = (keys.strafeRight ? 1 : 0) - (keys.strafeLeft ? 1 : 0);
    const vertDir = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);

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
      const newHeight = Math.max(MANUAL_MIN_HEIGHT_M, geo.height + manualVerticalSpeedMps * dt * vertDir);
      manualPosition = geodeticToCartesian(viewer, geo.lon + dLon, geo.lat + dLat, newHeight);
    }

    viewer.camera.setView({
      destination: manualPosition,
      orientation: { heading: toRad(manualHeadingDeg), pitch: toRad(manualPitchDeg), roll: 0 },
    });
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
    advanceManual(dt, manualKeys);
  }

  // 방향키(이동)와 화면 전환/상승하강이 서로 다른 물리 키라서, 실제 드론 조종기처럼
  // 다 같이 눌러도(예: 전진하면서 동시에 좌회전+상승) 그대로 동시에 반영된다.
  function handleManualKeyDown(e) {
    if (mode !== "manual") return;
    let handled = true;
    switch (e.code) {
      case "ArrowUp":
        setManualKey("forward", true);
        break;
      case "ArrowDown":
        setManualKey("backward", true);
        break;
      case "ArrowLeft":
        setManualKey("strafeLeft", true);
        break;
      case "ArrowRight":
        setManualKey("strafeRight", true);
        break;
      case "KeyW":
        setManualKey("lookUp", true);
        break;
      case "KeyS":
        setManualKey("lookDown", true);
        break;
      case "KeyA":
        setManualKey("lookLeft", true);
        break;
      case "KeyD":
        setManualKey("lookRight", true);
        break;
      case "KeyR":
        setManualKey("up", true);
        break;
      case "KeyF":
        setManualKey("down", true);
        break;
      case "Space":
        // 정지: 눌려있던 모든 이동 키를 초기화해서 즉시 제자리에 호버링한다.
        Object.keys(manualKeys).forEach((k) => setManualKey(k, false));
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
        setManualKey("forward", false);
        break;
      case "ArrowDown":
        setManualKey("backward", false);
        break;
      case "ArrowLeft":
        setManualKey("strafeLeft", false);
        break;
      case "ArrowRight":
        setManualKey("strafeRight", false);
        break;
      case "KeyW":
        setManualKey("lookUp", false);
        break;
      case "KeyS":
        setManualKey("lookDown", false);
        break;
      case "KeyA":
        setManualKey("lookLeft", false);
        break;
      case "KeyD":
        setManualKey("lookRight", false);
        break;
      case "KeyR":
        setManualKey("up", false);
        break;
      case "KeyF":
        setManualKey("down", false);
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
    // "드론뷰" 토글: 현재 보고 있는 화면 그대로에서 바로 수동 조종을 시작한다(위치/방향을 이어받음).
    start() {
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

    setManualSpeed(mps) {
      manualSpeedMps = Math.max(1, mps);
    },

    setManualVerticalSpeed(mps) {
      manualVerticalSpeedMps = Math.max(1, mps);
    },

    setManualLookRate(degPerS) {
      manualLookRateDegPerS = Math.max(0.1, degPerS);
    },

    // 지금 시야가 수평면 기준으로 몇 도 위/아래를 보고 있는지(0=수평, +=위, -=아래).
    getManualPitchDeg() {
      return manualPitchDeg;
    },

    // ---- 드론수동조정 입력 녹화 + 고정 프레임 재생(main.js에서 구동) ----
    // 실시간 조작은 그대로 두고(화면은 실시간으로 그대로 움직임), 키 입력 변화만 타임라인으로
    // 남긴다. 녹화를 멈춘 뒤 그 타임라인을 고정 프레임으로 재생하면서 캡처하면, 렌더링이
    // 버벅였던 구간도 항상 일정한 속도로 재현된 매끄러운 영상이 된다.
    isManualInputRecording() {
      return manualInputRecorder.isRecording();
    },

    beginManualInputRecording() {
      if (mode !== "manual") return false;
      manualInputRecordingStartPose = {
        position: { x: manualPosition.x, y: manualPosition.y, z: manualPosition.z },
        headingDeg: manualHeadingDeg,
        pitchDeg: manualPitchDeg,
      };
      manualInputRecorder.start();
      return true;
    },

    // 입력 기록을 멈추고 { events, durationSec, startPose }를 돌려준다.
    endManualInputRecording() {
      const { events, durationSec } = manualInputRecorder.stop();
      return { events, durationSec, startPose: manualInputRecordingStartPose };
    },

    // 재생 준비: 기록된 시작 자세로 되돌리고, 실시간 조작 루프는 잠깐 멈춘다(재생 중 사용자
    // 입력이 섞이지 않게). 재생은 main.js가 stepManualReplay를 고정 dt로 반복 호출해 구동한다.
    beginManualReplay(startPose) {
      stopManualLoop();
      manualPosition = { x: startPose.position.x, y: startPose.position.y, z: startPose.position.z };
      manualHeadingDeg = startPose.headingDeg;
      manualPitchDeg = startPose.pitchDeg;
      resetManualKeys();
    },

    stepManualReplay(dtSeconds, keys) {
      advanceManual(dtSeconds, keys);
    },

    // 재생이 끝난 뒤 다시 실시간 조작으로 복귀한다(재생이 끝난 지점부터 이어서 조작 가능).
    endManualReplay() {
      resetManualKeys();
      manualLastFrameTime = null;
      if (mode === "manual" && !removeManualPostRender) {
        removeManualPostRender = viewer.scene.postRender.addEventListener(manualTick);
      }
    },

    exit() {
      stopManualLoop();
      resetManualKeys();
      if (manualInputRecorder.isRecording()) manualInputRecorder.stop();
      setMode("idle");
    },

    isActive() {
      return mode !== "idle";
    },

    getMode() {
      return mode;
    },
  };
}
