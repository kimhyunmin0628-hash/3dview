let viewer;
let vwMap;
let orbit;
let drone;
let savedOverviewState = null;

// 조망 모드(벽면 지점에서 보기)인 동안 true. vworld가 매 프레임 자체적으로
// screenSpaceCameraController.enableInputs를 true로 되돌려놓기 때문에(camera.flyTo 완료 시점뿐 아니라
// 그 이후로도 계속), 한 번 끄는 것으로는 유지되지 않는다. 그래서 postRender마다 원하는 값으로
// 강제로 다시 맞춰준다 (아래 bootstrap의 postRender 리스너).
let viewpointModeActive = false;

// 화면 녹화 중인지. 드론뷰 여부와 별개로 지명 라벨을 숨겨야 하는 또 다른 조건이라
// setPoiLabelsVisible을 부를 때 둘 다 감안해야 한다(둘 중 하나라도 켜져 있으면 숨김).
let isRecordingActive = false;

// setupOrbitSliders()가 채워주는, 조망뷰 방향패드 입력 기록/재생 API(고정 프레임 녹화용).
let viewpointRecordingApi = null;

function flyToLocation(lon, lat, { height = 600, pitchDeg = -40 } = {}) {
  const { cartesian } = cartesianOnGround(viewer, lon, lat, height);
  viewer.camera.flyTo({
    destination: cartesian,
    orientation: { heading: 0, pitch: toRad(pitchDeg), roll: 0 },
    duration: 1.5,
  });
}

let __toastHideTimer = null;

function showToast(msg, isError = false) {
  const el = document.getElementById("status-toast");
  el.textContent = msg;
  el.classList.add("visible");
  el.style.borderLeft = isError ? "4px solid #ef4444" : "4px solid #3b82f6";

  if (__toastHideTimer) clearTimeout(__toastHideTimer); // 이전 토스트의 예약된 숨김이 새 토스트를 지우지 않게 취소
  if (!isError) {
    __toastHideTimer = setTimeout(() => el.classList.remove("visible"), 4000);
  }
}

// info-card는 한 번 뜨고 나면(=벽면을 한 번이라도 클릭하면) 이후로는 계속 떠 있는다.
// "닫기"는 층수/표고 상세 텍스트만 접을 뿐 카드 자체나 조망보기/전체보기 버튼은 건드리지
// 않아서, 전체보기에서는 "이 지점에서 조망보기"가, 조망 모드에서는 "전체보기로 돌아가기"가
// 항상 클릭 가능한 상태로 남아있게 한다.
function showInfoCard(picked) {
  window.__lastPicked = picked; // 디버깅용
  const card = document.getElementById("info-card");
  document.getElementById("info-floor").textContent =
    `약 ${picked.estimatedFloor}층 (지반 대비 +${picked.heightAboveGround.toFixed(1)}m)`;
  document.getElementById("info-elev").textContent =
    `지반고 ${picked.groundHeight.toFixed(1)}m / 클릭지점 표고 ${picked.clickedHeight.toFixed(1)}m`;
  document.getElementById("info-details").style.display = "block";
  document.getElementById("btn-close-info").style.display = "inline-block";
  card.classList.add("visible");

  // 새로 지점을 클릭했을 때 버튼 상태는 지금이 조망 모드인지 전체보기인지를 따라야 한다.
  // (조망 모드 중에 다른 벽을 클릭해도 "전체보기로 돌아가기"가 계속 보여야 함)
  document.getElementById("btn-view").style.display = viewpointModeActive ? "none" : "inline-block";
  document.getElementById("btn-back").style.display = viewpointModeActive ? "inline-block" : "none";

  document.getElementById("btn-view").onclick = () => {
    savedOverviewState = saveCameraState(viewer);
    viewpointModeActive = true; // 조망 모드: 마우스 조작 대신 방향 패드만 사용
    runCameraActionAfterClickSettles(() => {
      flyToViewpoint(viewer, picked, ({ destination, headingRad }) => {
        orbit = createViewpointLookControl(viewer, destination, headingRad);
      });
    });
    document.getElementById("btn-view").style.display = "none";
    document.getElementById("btn-back").style.display = "inline-block";
    document.getElementById("btn-drone-view").style.display = "none"; // 드론뷰는 전체보기 전용
  };
}

async function bootstrap() {
  try {
    showToast("vworld 3D 지도를 초기화하는 중...");
    const result = await initVWorldMap("vmap");
    viewer = result.viewer;
    vwMap = result.map;

    showToast("지도 초기화 완료");

    orbit = createOrbitControl(viewer);

    const pitchIndicator = document.getElementById("pitch-indicator");
    const pitchIndicatorValue = document.getElementById("pitch-indicator-value");
    viewer.scene.postRender.addEventListener(() => {
      viewer.scene.screenSpaceCameraController.enableInputs = !viewpointModeActive && !drone.isActive();

      // 드론수동조정 중에는 W/S로 조절하는 시야 각도(수평면 기준, 0=수평/+=위/-=아래)를
      // 나침반 아래에 실시간으로 보여준다.
      const isManual = drone.getMode() === "manual";
      pitchIndicator.classList.toggle("visible", isManual);
      if (isManual) {
        const pitchDeg = Math.round(drone.getManualPitchDeg());
        pitchIndicatorValue.textContent = `${pitchDeg > 0 ? "+" : ""}${pitchDeg}°`;
      }
    });

    enableBuildingViewPicker(viewer, vwMap, (picked) => {
      if (drone.isActive()) return; // 드론뷰 그리기/재생 중에는 건물 클릭을 무시한다
      showInfoCard(picked);
    });

    setupSearchForm();
    setupOrbitSliders();
    setupDpadDrag();
    setupDroneView();
    setupScreenRecorder();
    setupScreenCapture();

    document.getElementById("btn-back").onclick = () => {
      const target = savedOverviewState;
      runCameraActionAfterClickSettles(() => flyToOverview(viewer, target));
      viewpointModeActive = false; // 전체보기: 마우스 조작 복원
      orbit = createOrbitControl(viewer);
      // 전체보기로 돌아가면 배너 자체를 숨긴다. 다음 벽면 클릭 시 showInfoCard가 다시 띄운다.
      document.getElementById("info-card").classList.remove("visible");
      document.getElementById("btn-back").style.display = "none";
      document.getElementById("btn-drone-view").style.display = "inline-block";
    };

    document.getElementById("btn-close-info").onclick = () => {
      // 상세 텍스트만 접는다. 카드/조망보기·돌아가기 버튼은 그대로 둬서 계속 클릭할 수 있게 한다.
      document.getElementById("info-details").style.display = "none";
      document.getElementById("btn-close-info").style.display = "none";
    };
  } catch (err) {
    console.error(err);
    showToast(err.message || "초기화 중 오류가 발생했습니다.", true);
  }
}

function setupSearchForm() {
  const form = document.getElementById("search-form");
  const input = document.getElementById("search-input");

  // 일부 환경에서 인풋의 기본 "Enter=폼 제출" 동작이 안 먹는 경우가 있어 명시적으로도 처리한다.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) return;

    showToast(`"${query}" 검색 중...`);
    searchLocation(query)
      .then((loc) => {
        if (!loc) {
          showToast(`"${query}"에 대한 검색 결과가 없습니다.`, true);
          return;
        }
        showToast(`"${loc.title}"(으)로 이동합니다.`);
        runCameraActionAfterClickSettles(() => flyToLocation(loc.lon, loc.lat));
      })
      .catch((err) => {
        console.error(err);
        showToast(err.message || "검색 중 오류가 발생했습니다.", true);
      });
  });
}

// dpad 버튼은 항상 현재 컨트롤(orbit 변수)의 값을 읽어 그 프레임의 경과 시간(dt)만큼 이동시킨
// 뒤 다시 써준다. orbit은 전체보기에서는 createOrbitControl(피벗 중심 궤도), 조망 모드에서는
// createViewpointLookControl(고정 위치 제자리 회전)로 교체되는데, 두 컨트롤 다 같은
// begin/currentHeadingDegrees/currentElevationDegrees/setHeadingDegrees/setElevationDegrees
// 인터페이스를 구현하고 각자 알아서 각도를 clamp하므로 여기서는 범위를 신경 쓸 필요가 없다.
// postRender 매 프레임 dt 기반으로 갱신해서(예전의 setInterval 고정 스텝 대신) 버튼을 누르고
// 있는 동안 끊기지 않고 부드럽게 움직인다. 조망 모드(invertHeading===true)는 전체보기보다
// 30% 느린 속도로 움직이게 해서 좀 더 차분하게 살펴볼 수 있게 한다.
function setupOrbitSliders() {
  const HEADING_RATE_DEG_PER_S = 50; // 전체보기: 기존 3deg/60ms 스텝과 같은 체감 속도
  const PITCH_RATE_DEG_PER_S = 33.3;
  // 조망 모드는 전체보기 대비 24.5%(0.35의 70%) 속도로 움직인다.
  const VIEWPOINT_SPEED_FACTOR = 0.245;
  const VIEWPOINT_HEADING_RATE_DEG_PER_S = HEADING_RATE_DEG_PER_S * VIEWPOINT_SPEED_FACTOR;
  const VIEWPOINT_PITCH_RATE_DEG_PER_S = PITCH_RATE_DEG_PER_S * VIEWPOINT_SPEED_FACTOR;
  const VIEWPOINT_RAMP_TIME_S = 0.25; // 조망 모드에서 목표 속도까지 부드럽게 가속/감속하는 데 걸리는 시간

  const held = { left: false, right: false, up: false, down: false };
  let lastFrameTime = null;
  let tickRegistered = false;

  // 조망 모드 전용 가감속 상태. headingRamp/pitchRamp는 0(정지)~1(목표 속도)를 오가며,
  // 버튼을 막 떼도 즉시 멈추지 않고 관성이 있는 것처럼 부드럽게 줄어든다. lastHeadingDir/
  // lastPitchDir은 감속하는 동안(양쪽 다 안 눌린 상태) 어느 방향으로 계속 줄지 기억해둔다.
  let headingRamp = 0;
  let pitchRamp = 0;
  let lastHeadingDir = 1;
  let lastPitchDir = 1;

  function anyHeld() {
    return held.left || held.right || held.up || held.down;
  }

  // dt(초) 동안 heldState 기준으로 헤딩/피치를 전진시킨다. 실시간 조작(tick, 실제 dt)과
  // 조망뷰 재생(고정 프레임 녹화, 고정 dt) 양쪽에서 그대로 재사용한다.
  function advanceOrbitStep(dt, heldState) {
    const isViewpoint = orbit.invertHeading;
    const headingRate = isViewpoint ? VIEWPOINT_HEADING_RATE_DEG_PER_S : HEADING_RATE_DEG_PER_S;
    const pitchRate = isViewpoint ? VIEWPOINT_PITCH_RATE_DEG_PER_S : PITCH_RATE_DEG_PER_S;
    // 조망 모드(orbit.invertHeading===true)에서는 전체보기와 좌/우 버튼의 회전 방향이 반대가 되게 한다.
    const sign = isViewpoint ? -1 : 1;

    if (heldState.left) lastHeadingDir = 1;
    else if (heldState.right) lastHeadingDir = -1;
    if (heldState.up) lastPitchDir = 1;
    else if (heldState.down) lastPitchDir = -1;

    const headingTarget = heldState.left || heldState.right ? 1 : 0;
    const pitchTarget = heldState.up || heldState.down ? 1 : 0;

    if (isViewpoint) {
      // 목표값을 향해 매 프레임 일정 비율만큼만 다가가서(지수 감쇠) 자연스러운 가감속을 만든다.
      const step = Math.min(1, dt / VIEWPOINT_RAMP_TIME_S);
      headingRamp += (headingTarget - headingRamp) * step;
      pitchRamp += (pitchTarget - pitchRamp) * step;
      if (headingRamp < 0.001) headingRamp = 0;
      if (pitchRamp < 0.001) pitchRamp = 0;
    } else {
      // 전체보기는 기존과 동일하게 누르면 바로 목표 속도, 떼면 바로 정지.
      headingRamp = headingTarget;
      pitchRamp = pitchTarget;
    }

    if (headingRamp > 0) {
      orbit.setHeadingDegrees(orbit.currentHeadingDegrees() + sign * lastHeadingDir * headingRate * headingRamp * dt);
    }
    if (pitchRamp > 0) {
      orbit.setElevationDegrees(orbit.currentElevationDegrees() + lastPitchDir * pitchRate * pitchRamp * dt);
    }
  }

  function tick() {
    const decelerating = headingRamp > 0.001 || pitchRamp > 0.001;
    if (!anyHeld() && !decelerating) {
      lastFrameTime = null;
      return;
    }
    const now = performance.now();
    if (lastFrameTime == null) {
      lastFrameTime = now;
      return;
    }
    const dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    if (dt <= 0 || dt > 1) return;
    advanceOrbitStep(dt, held);
  }

  // 조망뷰 방향패드 입력을 기록했다가(고정 프레임 녹화용) 나중에 그대로 재생할 수 있게 한다.
  const viewpointInputRecorder = createInputTimelineRecorder();
  let viewpointInputRecordingStartState = null;

  function startHeld(key) {
    if (drone.isActive()) return; // 드론뷰 중엔 방향 패드로 궤도를 돌리지 않는다
    if (!orbit.begin()) return;
    if (!held[key]) {
      held[key] = true;
      viewpointInputRecorder.logChange(key, true);
    }
    if (!tickRegistered) {
      tickRegistered = true;
      viewer.scene.postRender.addEventListener(tick);
    }
  }

  function stopHeld(key) {
    if (held[key]) {
      held[key] = false;
      viewpointInputRecorder.logChange(key, false);
    }
  }

  function stopAllHeld() {
    Object.keys(held).forEach((k) => stopHeld(k));
  }

  // main.js의 녹화 버튼 로직(setupScreenRecorder)이 이 API로 조망뷰 입력 기록/재생을 구동한다.
  viewpointRecordingApi = {
    isViewpointActive() {
      return orbit.invertHeading === true;
    },
    begin() {
      if (!orbit.invertHeading) return false;
      viewpointInputRecordingStartState = {
        headingDeg: orbit.currentHeadingDegrees(),
        pitchDeg: orbit.currentElevationDegrees(),
      };
      viewpointInputRecorder.start();
      return true;
    },
    end() {
      const { events, durationSec } = viewpointInputRecorder.stop();
      return { events, durationSec, startState: viewpointInputRecordingStartState };
    },
    beginReplay(startState) {
      stopAllHeld();
      orbit.setHeadingDegrees(startState.headingDeg);
      orbit.setElevationDegrees(startState.pitchDeg);
      headingRamp = 0;
      pitchRamp = 0;
    },
    stepReplay(dtSeconds, heldState) {
      advanceOrbitStep(dtSeconds, heldState);
    },
    endReplay() {
      headingRamp = 0;
      pitchRamp = 0;
    },
  };

  function bindDpadButton(id, key) {
    const el = document.getElementById(id);
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      startHeld(key);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((evt) =>
      el.addEventListener(evt, () => stopHeld(key))
    );
  }

  bindDpadButton("dpad-left", "left");
  bindDpadButton("dpad-right", "right");
  bindDpadButton("dpad-up", "up");
  bindDpadButton("dpad-down", "down");

  window.addEventListener("pointerup", stopAllHeld);
}

// 방향 패드 가운데 손잡이(.dpad-center)를 눌러서 패널 전체(#orbit-panel)를 화면 어디로든
// 끌어다 놓을 수 있게 한다. 화살표 버튼 위에서 누르면 회전 조작(setupOrbitSliders)과
// 겹치므로, 드래그는 버튼이 아닌 가운데 손잡이에서만 시작한다.
function setupDpadDrag() {
  const panel = document.getElementById("orbit-panel");
  const handle = panel.querySelector(".dpad-center");

  let dragging = false;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  handle.addEventListener("pointerdown", (e) => {
    const rect = panel.getBoundingClientRect();
    dragging = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    // bottom/right로 위치가 잡혀 있을 수도 있으니 드래그 시작 시 top/left 기준으로 고정한다.
    panel.style.left = `${startLeft}px`;
    panel.style.top = `${startTop}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    handle.setPointerCapture(pointerId);
    e.preventDefault();
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const maxLeft = window.innerWidth - panel.offsetWidth;
    const maxTop = window.innerHeight - panel.offsetHeight;
    const newLeft = Math.max(0, Math.min(maxLeft, startLeft + (e.clientX - startX)));
    const newTop = Math.max(0, Math.min(maxTop, startTop + (e.clientY - startY)));
    panel.style.left = `${newLeft}px`;
    panel.style.top = `${newTop}px`;
  });

  ["pointerup", "pointercancel"].forEach((evt) =>
    handle.addEventListener(evt, () => {
      dragging = false;
    })
  );
}

// 드론뷰: "드론뷰" 버튼을 누르면 직선뷰/드론수동조정 중 하나를 고른다.
// - 직선뷰: 지날 지점 수(2~5개)를 고른 뒤, 지점마다 "고도 정하기 -> 지도에서 클릭"을
//   반복해서 경로를 완성하면, 재생 시 그 지점들을 순서대로 지나며 진행 방향을 본다.
// - 드론수동조정: 키보드로 직접 드론을 조종하면서 촬영한다(안내 문구는 droneView.js 참고).
// vworld 3D는 지명/POI 라벨을 별도의 3D Tileset(url에 "/poi/" 포함, 예: POI_BASE, POI_BOUND)으로
// 렌더링한다. 인덱스는 로드 시점에 따라 바뀔 수 있어서 매번 url로 찾아서 켜고 끈다.
function setPoiLabelsVisible(visible) {
  const primitives = viewer.scene.primitives;
  for (let i = 0; i < primitives.length; i++) {
    const p = primitives.get(i);
    const url = p._url || p.url;
    if (typeof url === "string" && url.includes("/poi/")) {
      p.show = visible;
    }
  }
}

// line-altitude/line-pick은 "N번째 지점" 같은 동적인 안내가 필요해서 여기 없이
// setupDroneView()의 onModeChange에서 따로 문구를 만든다.
const DRONE_STATUS_TEXT = {
  choosing: "직선뷰 또는 드론수동조정을 선택하세요",
  "line-count": "몇 개 지점을 지나는 경로로 촬영할까요?",
  ready: "경로가 준비됐습니다. 재생을 눌러보세요",
  playing: "드론이 경로를 비행 중입니다",
  manual: "방향키로 이동, WSAD로 시야 전환, R/F로 상승/하강하세요",
};

function setupDroneView() {
  const overlay = document.getElementById("drone-overlay");
  const panel = document.getElementById("drone-panel");
  const statusEl = document.getElementById("drone-status");
  const chooseActionsEl = document.getElementById("drone-choose-actions");
  const lineCountOptionsEl = document.getElementById("drone-line-count-options");
  const lineAltitudeOptionsEl = document.getElementById("drone-line-altitude-options");
  const manualOptionsEl = document.getElementById("drone-manual-options");
  const playControlsEl = document.getElementById("drone-play-controls");
  const btnCollapse = document.getElementById("btn-drone-panel-collapse");
  const btnToggle = document.getElementById("btn-drone-view");
  const btnLine = document.getElementById("btn-drone-line");
  const btnManual = document.getElementById("btn-drone-manual");
  const btnPlay = document.getElementById("btn-drone-play");
  const btnRedraw = document.getElementById("btn-drone-redraw");
  const btnExit = document.getElementById("btn-drone-exit");
  const speedInput = document.getElementById("drone-speed");
  const speedValue = document.getElementById("drone-speed-value");
  const linePointAltitudeLabel = document.getElementById("drone-line-point-altitude-label");
  const linePointAltitudeInput = document.getElementById("drone-line-point-altitude");
  const linePointAltitudeValue = document.getElementById("drone-line-point-altitude-value");
  const btnLineConfirmAltitude = document.getElementById("btn-drone-line-confirm-altitude");
  const manualSpeedInput = document.getElementById("drone-manual-speed");
  const manualSpeedValue = document.getElementById("drone-manual-speed-value");

  drone = createDroneView(viewer, overlay, {
    onModeChange(mode) {
      panel.classList.toggle("visible", mode !== "idle");
      panel.classList.toggle("manual-mode", mode === "manual");
      if (mode === "idle") panel.classList.remove("collapsed"); // 다음에 열 때는 항상 펼쳐진 상태로 시작
      setPoiLabelsVisible(mode === "idle" && !isRecordingActive); // 드론뷰 동안에는 지명/POI 글자를 없애서 촬영 화면을 깔끔하게 유지
      overlay.classList.toggle("active", drone.isWaitingForInput());
      document.getElementById("orbit-panel").style.display = mode === "idle" ? "flex" : "none";

      if (mode === "line-altitude" || mode === "line-pick") {
        const pointNo = drone.getLinePointIndex() + 1;
        const total = drone.getLinePointCount();
        statusEl.textContent =
          mode === "line-altitude"
            ? `${pointNo}번째 지점(총 ${total}개)의 고도를 정한 뒤 "지점 선택하기"를 누르세요`
            : `${pointNo}번째 지점을 지도에서 클릭하세요`;
      } else {
        statusEl.textContent = DRONE_STATUS_TEXT[mode] || "";
      }
      if (mode === "line-altitude") {
        const altitude = drone.getCurrentLinePointAltitude();
        linePointAltitudeLabel.textContent = `${drone.getLinePointIndex() + 1}번째 지점 고도(지면 위)`;
        linePointAltitudeInput.value = altitude;
        linePointAltitudeValue.textContent = altitude;
      }
      chooseActionsEl.style.display = mode === "choosing" ? "flex" : "none";
      lineCountOptionsEl.style.display = mode === "line-count" ? "block" : "none";
      lineAltitudeOptionsEl.style.display = mode === "line-altitude" ? "block" : "none";
      manualOptionsEl.style.display = mode === "manual" ? "block" : "none";
      playControlsEl.style.display = mode === "ready" || mode === "playing" ? "block" : "none";

      if (mode === "ready") {
        btnPlay.disabled = false;
        btnPlay.textContent = "▶ 재생";
      } else if (mode === "playing") {
        btnPlay.disabled = false;
        btnPlay.textContent = "⏸ 정지";
      }
    },
    onTooShort() {
      showToast("선이 너무 짧습니다. 다시 그려주세요.", true);
    },
    onFinished() {
      showToast("드론 비행이 끝났습니다.");
    },
  });

  btnToggle.onclick = () => {
    document.getElementById("info-card").classList.remove("visible");
    drone.startChoosing();
  };

  btnLine.onclick = () => drone.chooseLineCount();

  [2, 3, 4, 5].forEach((n) => {
    document.getElementById(`btn-drone-line-count-${n}`).onclick = () => drone.setLinePointCount(n);
  });

  btnLineConfirmAltitude.onclick = () => drone.confirmLinePointAltitude();

  btnManual.onclick = () => {
    drone.setManualSpeed(Number(manualSpeedInput.value));
    // vworld가 버튼 클릭 자체에도 카메라를 살짝 건드리는 특성이 있어서(main.js 하단 주석 참고),
    // 그 흔들림이 가라앉은 뒤에 현재 위치/방향을 캡처해야 엉뚱한 지점에서 시작하지 않는다.
    runCameraActionAfterClickSettles(() => drone.chooseManual());
  };

  btnPlay.onclick = () => {
    if (drone.getMode() === "playing") drone.pause();
    else drone.play();
  };

  // 다시 그리기는 직선뷰/드론수동조정을 다시 고르는 단계로 돌아간다.
  btnRedraw.onclick = () => drone.startChoosing();

  btnExit.onclick = () => drone.exit();

  btnCollapse.onclick = () => {
    const collapsed = panel.classList.toggle("collapsed");
    btnCollapse.setAttribute("aria-label", collapsed ? "안내 펼치기" : "안내 최소화");
  };

  linePointAltitudeInput.addEventListener("input", () => {
    const m = Number(linePointAltitudeInput.value);
    linePointAltitudeValue.textContent = m;
    drone.setLinePointAltitude(m);
  });

  manualSpeedInput.addEventListener("input", () => {
    const mps = Number(manualSpeedInput.value);
    manualSpeedValue.textContent = mps;
    drone.setManualSpeed(mps);
  });

  speedInput.addEventListener("input", () => {
    const mps = Number(speedInput.value);
    speedValue.textContent = mps;
    drone.setSpeed(mps);
  });

  overlay.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    drone.handlePointerDown(e);
  });
  overlay.addEventListener("pointermove", (e) => drone.handlePointerMove(e));
  window.addEventListener("pointerup", (e) => drone.handlePointerUp(e));
  window.addEventListener("resize", () => drone.resizeOverlay());
}

// 녹화가 끝난 뒤 공통으로 하는 일: 저장할지 물어보고, 원하면 파일로 저장한다.
// window.confirm은 사용자가 "예"를 누른 시점의 클릭이 이 함수를 호출한 원래 클릭(녹화 시작
// 버튼 등)과 이미 멀어져 있어서, 그 직후 showSaveFilePicker를 불러도 브라우저가 "방금 사용자가
// 누른 것"으로 인정하지 않아 조용히 다운로드 폴더로 대체돼버리는 경우가 있었다(그래서 "어떨
// 땐 저장 위치를 물어보고 어떨 땐 그냥 다운로드된다"는 문제가 생겼다). 그래서 직접 만든
// 저장/취소 버튼을 쓰고, "저장" 버튼의 클릭 핸들러 안에서 곧바로 saveBlobAsFile(=
// showSaveFilePicker)를 불러서 항상 그 클릭을 기준으로 인정받게 한다.
function finishRecordingSaveFlow(result) {
  return new Promise((resolve) => {
    const { blob, ext } = result;
    const panel = document.getElementById("save-prompt");
    const messageEl = document.getElementById("save-prompt-message");
    const btnSave = document.getElementById("btn-save-confirm");
    const btnCancel = document.getElementById("btn-save-cancel");

    messageEl.textContent =
      ext === "mp4"
        ? "촬영을 마쳤습니다. mp4 파일로 저장하시겠습니까?"
        : "촬영을 마쳤습니다. 이 브라우저는 mp4 직접 녹화를 지원하지 않아 webm으로 저장됩니다. 저장하시겠습니까?";
    panel.classList.add("visible");

    function cleanup() {
      panel.classList.remove("visible");
      btnSave.onclick = null;
      btnCancel.onclick = null;
    }

    btnSave.onclick = async () => {
      cleanup();
      const filename = `drone-view-${Date.now()}.${ext}`;
      try {
        await saveBlobAsFile(blob, filename); // 폴더를 이전에 저장했던 곳으로 기본 지정해주는 것도 브라우저가 원본 사이트별로 기억해서 알아서 해준다.
        showToast("저장했습니다.");
      } catch (err) {
        if (err.name !== "AbortError") {
          console.error(err);
          showToast("저장 중 오류가 발생했습니다.", true);
        }
      }
      resolve();
    };

    btnCancel.onclick = () => {
      cleanup();
      resolve();
    };
  });
}

const LOCKED_RECORDING_FIXED_DT_S = 1 / 30; // 항상 이 간격만큼만 전진시켜서, 실제 렌더링 속도와 무관하게 매끄러운 결과를 만든다.
const RECORDING_FRAME_INTERVAL_MS = 1000 / 30; // 캡처하는 실제 간격도 30fps에 맞춰야 재생 속도가 맞다(아래 설명).

// 다음으로 "실제로 다 그려진(postRender)" 시점에 딱 맞춰 한 프레임을 캡처한다. 두 가지를
// 한 번에 해결한다:
// 1) WebGL 캔버스는 그려지고 나면 버퍼가 금방 비워질 수 있어서, requestAnimationFrame이나
//    setTimeout으로 "적당히 그려졌겠지" 하고 나중에 긁어오면 화면이 안 보이거나(빈 프레임)
//    한 번씩만 제대로 보이는 문제가 있었다. postRender 콜백 "안에서" 바로 캡처해야
//    버퍼가 아직 살아있는 시점을 잡을 수 있다.
// 2) postRender는 보통 화면 주사율(예: 60Hz)만큼 자주 일어나는데, 그때마다 다 캡처하면
//    "한 걸음 = 1/30초"로 진행시킨 내용이 실제로는 그보다 훨씬 자주(예: 60fps로) 찍혀서,
//    30fps로 재생하면 실제보다 빠르게 재생되는 문제가 있었다. 그래서 마지막 캡처로부터
//    30fps 간격(약 33.3ms)이 지난 postRender만 골라서 캡처한다.
function waitForPacedRender(recorder, lastCaptureTimeState) {
  return new Promise((resolve) => {
    function onPostRender() {
      const now = performance.now();
      if (now - lastCaptureTimeState.t < RECORDING_FRAME_INTERVAL_MS) return; // 아직 30fps 간격이 안 됨, 다음 postRender까지 계속 기다린다
      viewer.scene.postRender.removeEventListener(onPostRender);
      recorder.captureFrame(); // 방금 그려진 그 프레임을, 버퍼가 살아있는 지금 바로 긁어온다
      lastCaptureTimeState.t = now;
      resolve();
    }
    viewer.scene.postRender.addEventListener(onPostRender);
  });
}

// 드론 직선뷰가 "재생 준비됨" 상태일 때만 쓸 수 있는 고정 프레임 녹화. 재생을 실제 시간이
// 아니라 고정된 간격으로 우리가 직접 한 걸음씩 몰아서 진행시키고, 매 걸음마다 그 순간의
// 화면을 프레임으로 찍어 넣는다. 3D 타일 로딩 등으로 렌더링이 느려지는 구간이 있어도 진행
// 속도 자체는 항상 일정해서, 실시간 녹화와 달리 결과 영상이 끊겨 보이지 않는다. 대신 로딩이
// 느리면 녹화가 끝나는 데 걸리는 실제 시간은 영상 길이보다 더 걸릴 수 있다.
async function runLockedLineFlightRecording(recorder, shouldCancel) {
  if (!drone.beginLockedLineFlight()) return null;

  try {
    recorder.startLocked();
  } catch (err) {
    drone.endLockedLineFlight();
    throw err;
  }

  const lastCaptureTimeState = { t: performance.now() };
  let finished = false;
  while (!finished) {
    if (drone.getMode() !== "playing") break; // 녹화 도중 드론뷰가 종료되는 등 외부 요인으로 중단
    if (shouldCancel()) break; // 녹화 버튼을 다시 눌러 직접 멈춘 경우
    finished = drone.stepLockedLineFlight(LOCKED_RECORDING_FIXED_DT_S);
    await waitForPacedRender(recorder, lastCaptureTimeState);
  }

  drone.endLockedLineFlight();
  return recorder.stop();
}

// 드론수동조정/조망뷰처럼 "미리 정해진 경로가 없는" 조작은, 사용자가 실시간으로 한 번 조작하는
// 동안 입력 변화만 타임라인으로 기록해뒀다가(각 stepFn 소유자의 begin~end 구간), 그 타임라인을
// 고정 프레임으로 그대로 재생하면서 캡처한다. recordedInput은 { events, durationSec, ... } 형태.
async function runReplayCapture(recorder, recordedInput, stepFn, shouldCancel) {
  try {
    recorder.startLocked();
  } catch (err) {
    throw err;
  }

  const events = recordedInput.events;
  const totalDuration = recordedInput.durationSec;
  const replayKeys = {
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
    left: false,
    right: false,
  };
  let eventIndex = 0;
  let simTime = 0;
  const lastCaptureTimeState = { t: performance.now() };

  while (simTime < totalDuration) {
    if (shouldCancel()) break;
    while (eventIndex < events.length && events[eventIndex].tSec <= simTime) {
      replayKeys[events[eventIndex].key] = events[eventIndex].pressed;
      eventIndex++;
    }
    stepFn(LOCKED_RECORDING_FIXED_DT_S, replayKeys);
    simTime += LOCKED_RECORDING_FIXED_DT_S;
    await waitForPacedRender(recorder, lastCaptureTimeState);
  }

  return recorder.stop();
}

async function runManualReplayRecording(recorder, recordedInput, shouldCancel) {
  drone.beginManualReplay(recordedInput.startPose);
  try {
    return await runReplayCapture(recorder, recordedInput, (dt, keys) => drone.stepManualReplay(dt, keys), shouldCancel);
  } finally {
    drone.endManualReplay();
  }
}

async function runViewpointReplayRecording(recorder, recordedInput, shouldCancel) {
  viewpointRecordingApi.beginReplay(recordedInput.startState);
  try {
    return await runReplayCapture(recorder, recordedInput, (dt, keys) => viewpointRecordingApi.stepReplay(dt, keys), shouldCancel);
  } finally {
    viewpointRecordingApi.endReplay();
  }
}

// 화면(3D 지도) 녹화: 사이드바 상단의 녹화 아이콘을 누르면 시작, 다시 누르면 중지하고 저장
// 여부를 물어본 뒤 mp4(또는 브라우저가 지원 안 하면 webm)로 저장한다. 상황에 따라 네 가지
// 방식 중 하나로 동작한다(고정 프레임 녹화를 지원하는 브라우저에 한해):
// - 드론 직선뷰 "재생 준비됨": 경로를 고정 프레임으로 직접 재생하며 녹화(runLockedLineFlightRecording)
// - 드론수동조정 중: 조작 입력을 기록 -> 다시 누르면 그 조작을 고정 프레임으로 재생하며 녹화
// - 조망뷰 중: 방향패드 입력을 기록 -> 다시 누르면 그 조작을 고정 프레임으로 재생하며 녹화
// - 그 외(일반 화면 등): 기존처럼 화면을 실시간 그대로 녹화
// 두 "입력 기록" 방식은 재생/녹화 단계에서 다시 누르면 그때까지 찍은 만큼만 저장하고 멈춘다.
function setupScreenRecorder() {
  const btn = document.getElementById("btn-record");
  const glyph = btn.querySelector(".icon-btn-glyph");
  const tooltip = btn.querySelector(".icon-btn-tooltip");
  const recorder = createScreenRecorder(viewer.scene.canvas);

  if (!recorder.isSupported()) {
    btn.disabled = true;
    tooltip.textContent = "이 브라우저는 화면 녹화를 지원하지 않습니다";
    return;
  }

  function markRecordingUi(recording, tooltipText) {
    btn.classList.toggle("recording", recording);
    glyph.textContent = recording ? "⏹" : "⏺";
    tooltip.textContent = tooltipText;
  }

  // idle | locked-line | manual-input | manual-replay | viewpoint-input | viewpoint-replay | realtime
  let phase = "idle";
  let cancelRequested = false;

  async function finishPhase(result) {
    isRecordingActive = false;
    setPoiLabelsVisible(drone.getMode() === "idle");
    markRecordingUi(false, "화면 녹화");
    phase = "idle";
    if (result) await finishRecordingSaveFlow(result);
  }

  btn.onclick = async () => {
    // ---- 입력을 기록하던 중이면: 다시 누른 건 "이제 그 조작을 영상으로 만들어라"는 뜻 ----
    if (phase === "manual-input") {
      const recorded = drone.endManualInputRecording();
      phase = "manual-replay";
      cancelRequested = false;
      markRecordingUi(true, "재생 영상 만드는 중...");
      showToast("방금 조작을 고정 프레임으로 다시 재생하며 녹화합니다.");
      let result = null;
      try {
        result = await runManualReplayRecording(recorder, recorded, () => cancelRequested);
      } catch (err) {
        console.error(err);
        showToast(err.message || "녹화 영상을 만들지 못했습니다.", true);
      }
      await finishPhase(result);
      return;
    }

    if (phase === "viewpoint-input") {
      const recorded = viewpointRecordingApi.end();
      phase = "viewpoint-replay";
      cancelRequested = false;
      markRecordingUi(true, "재생 영상 만드는 중...");
      showToast("방금 조작을 고정 프레임으로 다시 재생하며 녹화합니다.");
      let result = null;
      try {
        result = await runViewpointReplayRecording(recorder, recorded, () => cancelRequested);
      } catch (err) {
        console.error(err);
        showToast(err.message || "녹화 영상을 만들지 못했습니다.", true);
      }
      await finishPhase(result);
      return;
    }

    // ---- 고정 프레임 재생/녹화가 이미 진행 중이면: 다시 누른 건 "지금까지만 저장해라" ----
    if (phase === "locked-line" || phase === "manual-replay" || phase === "viewpoint-replay") {
      cancelRequested = true; // 다음 걸음에서 루프가 멈춘다
      return;
    }

    // ---- 실시간 녹화 중이면: 다시 누른 건 정지 ----
    if (phase === "realtime") {
      btn.disabled = true;
      let result;
      try {
        result = await recorder.stop();
      } catch (err) {
        console.error(err);
        showToast("녹화를 마치지 못했습니다.", true);
        btn.disabled = false;
        isRecordingActive = false;
        setPoiLabelsVisible(drone.getMode() === "idle");
        phase = "idle";
        return;
      }
      btn.disabled = false;
      await finishPhase(result);
      return;
    }

    // ---- 아무것도 진행 중이 아니면: 지금 화면 상황에 맞는 녹화를 새로 시작 ----
    if (drone.getMode() === "ready" && recorder.isLockedFrameSupported()) {
      phase = "locked-line";
      cancelRequested = false;
      isRecordingActive = true;
      setPoiLabelsVisible(false);
      markRecordingUi(true, "고정 프레임 녹화 중 (다시 누르면 중지)");
      showToast("직선뷰를 고정 프레임으로 녹화합니다. 로딩 상황에 따라 시간이 걸릴 수 있어요.");
      let result = null;
      try {
        result = await runLockedLineFlightRecording(recorder, () => cancelRequested);
      } catch (err) {
        console.error(err);
        showToast(err.message || "녹화를 시작하지 못했습니다.", true);
      }
      await finishPhase(result);
      return;
    }

    if (drone.getMode() === "manual" && recorder.isLockedFrameSupported() && drone.beginManualInputRecording()) {
      phase = "manual-input";
      isRecordingActive = true;
      setPoiLabelsVisible(false);
      markRecordingUi(true, "조작 기록 중 (다시 누르면 녹화 영상 생성)");
      showToast("지금부터 조작을 기록합니다. 다시 누르면 방금 조작을 매끄러운 영상으로 만들어요.");
      return;
    }

    if (
      viewpointRecordingApi &&
      viewpointRecordingApi.isViewpointActive() &&
      !drone.isActive() &&
      recorder.isLockedFrameSupported() &&
      viewpointRecordingApi.begin()
    ) {
      phase = "viewpoint-input";
      isRecordingActive = true;
      setPoiLabelsVisible(false);
      markRecordingUi(true, "조작 기록 중 (다시 누르면 녹화 영상 생성)");
      showToast("지금부터 조작을 기록합니다. 다시 누르면 방금 조작을 매끄러운 영상으로 만들어요.");
      return;
    }

    // ---- 그 외(일반 화면 등): 기존처럼 실시간 녹화 ----
    try {
      recorder.start();
      phase = "realtime";
      isRecordingActive = true;
      setPoiLabelsVisible(false); // 녹화 중에는 지명/POI 글자가 영상에 안 남게 숨긴다
      markRecordingUi(true, "녹화 중지");
      showToast("화면 녹화를 시작합니다.");
    } catch (err) {
      console.error(err);
      showToast(err.message || "녹화를 시작하지 못했습니다.", true);
    }
  };
}

// 지금 화면(3D 지도 캔버스)을 한 장 캡처해서 png로 저장한다. WebGL 캔버스는 렌더링 직후
// 화면에 표시되고 나면 버퍼가 비워질 수 있어서, canvas.toBlob()을 아무 때나 부르면 빈 이미지가
// 나올 수 있다. 그래서 postRender(막 그린 직후) 시점에 맞춰 그 안에서 바로 캡처한다.
function captureCanvasScreenshot() {
  return new Promise((resolve, reject) => {
    const canvas = viewer.scene.canvas;
    const onPostRender = () => {
      viewer.scene.postRender.removeEventListener(onPostRender);
      // 녹화와 마찬가지로 유튜브 표준 화면비(16:9)에 맞춰 중앙 기준으로 잘라서 저장한다.
      const crop = computeAspectCrop(canvas.width, canvas.height, CAPTURE_ASPECT_RATIO);
      const cropped = document.createElement("canvas");
      cropped.width = crop.sw;
      cropped.height = crop.sh;
      cropped.getContext("2d").drawImage(canvas, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
      cropped.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("캡처에 실패했습니다."));
      }, "image/png");
    };
    viewer.scene.postRender.addEventListener(onPostRender);
  });
}

function setupScreenCapture() {
  const btn = document.getElementById("btn-screenshot");

  btn.onclick = async () => {
    btn.disabled = true;
    let blob;
    try {
      blob = await captureCanvasScreenshot();
    } catch (err) {
      console.error(err);
      showToast("캡처 중 오류가 발생했습니다.", true);
      btn.disabled = false;
      return;
    }
    btn.disabled = false;

    if (!window.confirm("지금 화면을 캡처했습니다. 이미지 파일로 저장하시겠습니까?")) return;

    const filename = `drone-view-${Date.now()}.png`;
    try {
      await saveBlobAsFile(blob, filename);
      showToast("저장했습니다.");
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error(err);
        showToast("저장 중 오류가 발생했습니다.", true);
      }
    }
  };
}

// 주의: vworld는 UI 버튼 클릭에도 자체적으로 반응해서(같은 클릭 이벤트에 얹혀) 카메라를
// 살짝 움직이는 내부 동작이 있는 것으로 실측 확인됐다(정확한 내부 로직은 알 수 없음).
// stopPropagation으로는 우리 자신의 버튼 핸들러까지 막혀버려서, 대신 우리 쪽 카메라 이동을
// 이 이벤트 틱이 끝난 뒤로 살짝 미뤄서(setTimeout) 항상 우리가 마지막에 최종 시점을 확정한다.
function runCameraActionAfterClickSettles(fn) {
  setTimeout(fn, 150);
}

window.addEventListener("DOMContentLoaded", bootstrap);
