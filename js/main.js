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

    viewer.scene.postRender.addEventListener(() => {
      viewer.scene.screenSpaceCameraController.enableInputs = !viewpointModeActive && !drone.isActive();
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
  const VIEWPOINT_SPEED_FACTOR = 0.7; // 조망 모드는 기존 대비 30% 느리게
  const VIEWPOINT_HEADING_RATE_DEG_PER_S = HEADING_RATE_DEG_PER_S * VIEWPOINT_SPEED_FACTOR;
  const VIEWPOINT_PITCH_RATE_DEG_PER_S = PITCH_RATE_DEG_PER_S * VIEWPOINT_SPEED_FACTOR;

  const held = { left: false, right: false, up: false, down: false };
  let lastFrameTime = null;
  let tickRegistered = false;

  function anyHeld() {
    return held.left || held.right || held.up || held.down;
  }

  function tick() {
    if (!anyHeld()) {
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

    const headingRate = orbit.invertHeading ? VIEWPOINT_HEADING_RATE_DEG_PER_S : HEADING_RATE_DEG_PER_S;
    const pitchRate = orbit.invertHeading ? VIEWPOINT_PITCH_RATE_DEG_PER_S : PITCH_RATE_DEG_PER_S;
    // 조망 모드(orbit.invertHeading===true)에서는 전체보기와 좌/우 버튼의 회전 방향이 반대가 되게 한다.
    const sign = orbit.invertHeading ? -1 : 1;

    if (held.left || held.right) {
      const dir = held.left ? 1 : -1;
      orbit.setHeadingDegrees(orbit.currentHeadingDegrees() + sign * dir * headingRate * dt);
    }
    if (held.up || held.down) {
      const dir = held.up ? 1 : -1;
      orbit.setElevationDegrees(orbit.currentElevationDegrees() + dir * pitchRate * dt);
    }
  }

  function startHeld(key) {
    if (drone.isActive()) return; // 드론뷰 중엔 방향 패드로 궤도를 돌리지 않는다
    if (!orbit.begin()) return;
    held[key] = true;
    if (!tickRegistered) {
      tickRegistered = true;
      viewer.scene.postRender.addEventListener(tick);
    }
  }

  function stopHeld(key) {
    held[key] = false;
  }

  function stopAllHeld() {
    held.left = held.right = held.up = held.down = false;
  }

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
  manual: "방향키로 이동, Shift+방향키로 시야 전환, W/S로 상승/하강하세요",
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
      setPoiLabelsVisible(mode === "idle"); // 드론뷰 동안에는 지명/POI 글자를 없애서 촬영 화면을 깔끔하게 유지
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

// 화면(3D 지도) 녹화: 사이드바 상단의 녹화 아이콘을 누르면 시작, 다시 누르면 중지하고
// 저장 여부를 물어본 뒤 mp4(또는 브라우저가 지원 안 하면 webm)로 저장한다.
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

  btn.onclick = async () => {
    if (!recorder.isRecording()) {
      try {
        recorder.start();
        btn.classList.add("recording");
        glyph.textContent = "⏹";
        tooltip.textContent = "녹화 중지";
        showToast("화면 녹화를 시작합니다.");
      } catch (err) {
        console.error(err);
        showToast(err.message || "녹화를 시작하지 못했습니다.", true);
      }
      return;
    }

    btn.disabled = true;
    let result;
    try {
      result = await recorder.stop();
    } catch (err) {
      console.error(err);
      showToast("녹화를 마치지 못했습니다.", true);
      btn.disabled = false;
      return;
    }
    btn.classList.remove("recording");
    glyph.textContent = "⏺";
    tooltip.textContent = "화면 녹화";
    btn.disabled = false;

    const { blob, ext } = result;
    const wantsSave = window.confirm(
      ext === "mp4"
        ? "촬영을 마쳤습니다. mp4 파일로 저장하시겠습니까?"
        : "촬영을 마쳤습니다. 이 브라우저는 mp4 직접 녹화를 지원하지 않아 webm으로 저장됩니다. 저장하시겠습니까?"
    );
    if (!wantsSave) return;

    const filename = `drone-view-${Date.now()}.${ext}`;
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
