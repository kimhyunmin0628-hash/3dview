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

// dpad 버튼은 항상 현재 컨트롤(orbit 변수)의 값을 읽어 한 스텝만큼 더한 뒤 다시 써준다.
// orbit은 전체보기에서는 createOrbitControl(피벗 중심 궤도), 조망 모드에서는
// createViewpointLookControl(고정 위치 제자리 회전)로 교체되는데, 두 컨트롤 다 같은
// begin/currentHeadingDegrees/currentElevationDegrees/setHeadingDegrees/setElevationDegrees
// 인터페이스를 구현하고 각자 알아서 각도를 clamp하므로 여기서는 범위를 신경 쓸 필요가 없다.
function setupOrbitSliders() {
  const HEADING_STEP_DEG = 3;
  const PITCH_STEP_DEG = 2;
  const REPEAT_MS = 60;

  let repeatId = null;

  function stopRepeat() {
    if (repeatId !== null) {
      clearInterval(repeatId);
      repeatId = null;
    }
  }

  function startRepeat(step) {
    stopRepeat();
    if (drone.isActive()) return; // 드론뷰 중엔 방향 패드로 궤도를 돌리지 않는다
    if (!orbit.begin()) return;
    step();
    repeatId = setInterval(step, REPEAT_MS);
  }

  function bindDpadButton(id, step) {
    const el = document.getElementById(id);
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      startRepeat(step);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((evt) => el.addEventListener(evt, stopRepeat));
  }

  // 조망 모드(orbit.invertHeading===true)에서는 전체보기와 좌/우 버튼의 회전 방향이 반대가 되게 한다.
  bindDpadButton("dpad-left", () => {
    const sign = orbit.invertHeading ? -1 : 1;
    orbit.setHeadingDegrees(orbit.currentHeadingDegrees() + sign * HEADING_STEP_DEG);
  });
  bindDpadButton("dpad-right", () => {
    const sign = orbit.invertHeading ? -1 : 1;
    orbit.setHeadingDegrees(orbit.currentHeadingDegrees() - sign * HEADING_STEP_DEG);
  });
  bindDpadButton("dpad-up", () => orbit.setElevationDegrees(orbit.currentElevationDegrees() + PITCH_STEP_DEG));
  bindDpadButton("dpad-down", () => orbit.setElevationDegrees(orbit.currentElevationDegrees() - PITCH_STEP_DEG));

  window.addEventListener("pointerup", stopRepeat);
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

// 드론뷰: "드론뷰" 버튼을 누르면 직선뷰/회전뷰 중 하나를 고르고, 그에 맞는 방식으로 지도를
// 클릭/드래그해서 경로를 정하면, 재생 시 그 경로를 따라 날아가며(직선뷰: 진행방향을 보고,
// 회전뷰: 지정한 중심점을 계속 바라보며) 촬영하듯 카메라가 움직인다.
const DRONE_STATUS_TEXT = {
  choosing: "직선뷰 또는 회전뷰를 선택하세요",
  "line-start": "지도에서 비행을 시작할 지점을 클릭하세요",
  "line-end": "이제 도착 지점을 클릭하세요",
  "orbit-draw": "지도를 마우스로 누른 채 드래그해서 회전 궤도(원 또는 타원)를 그려보세요",
  "orbit-center": "회전하는 동안 계속 바라볼 중심 지점을 클릭하세요",
  ready: "경로가 준비됐습니다. 재생을 눌러보세요",
  playing: "드론이 경로를 비행 중입니다",
};

// 시작점/끝점 고도 슬라이더(직선뷰) / 회전 고도 슬라이더(회전뷰)를 보여줄 단계들.
const DRONE_LINE_OPTION_MODES = ["line-start", "line-end"];
const DRONE_ORBIT_OPTION_MODES = ["orbit-draw", "orbit-center"];

function setupDroneView() {
  const overlay = document.getElementById("drone-overlay");
  const panel = document.getElementById("drone-panel");
  const statusEl = document.getElementById("drone-status");
  const chooseActionsEl = document.getElementById("drone-choose-actions");
  const lineOptionsEl = document.getElementById("drone-line-options");
  const orbitOptionsEl = document.getElementById("drone-orbit-options");
  const playControlsEl = document.getElementById("drone-play-controls");
  const btnToggle = document.getElementById("btn-drone-view");
  const btnLine = document.getElementById("btn-drone-line");
  const btnOrbit = document.getElementById("btn-drone-orbit");
  const btnPlay = document.getElementById("btn-drone-play");
  const btnRedraw = document.getElementById("btn-drone-redraw");
  const btnExit = document.getElementById("btn-drone-exit");
  const speedInput = document.getElementById("drone-speed");
  const speedValue = document.getElementById("drone-speed-value");
  const lineStartAltitudeInput = document.getElementById("drone-line-start-altitude");
  const lineStartAltitudeValue = document.getElementById("drone-line-start-altitude-value");
  const lineEndAltitudeInput = document.getElementById("drone-line-end-altitude");
  const lineEndAltitudeValue = document.getElementById("drone-line-end-altitude-value");
  const orbitAltitudeInput = document.getElementById("drone-orbit-altitude");
  const orbitAltitudeValue = document.getElementById("drone-orbit-altitude-value");
  const centerAltitudeInput = document.getElementById("drone-center-altitude");
  const centerAltitudeValue = document.getElementById("drone-center-altitude-value");

  drone = createDroneView(viewer, overlay, {
    onModeChange(mode) {
      panel.classList.toggle("visible", mode !== "idle");
      overlay.classList.toggle("active", drone.isWaitingForInput());
      document.getElementById("orbit-panel").style.display = mode === "idle" ? "flex" : "none";

      statusEl.textContent = DRONE_STATUS_TEXT[mode] || "";
      chooseActionsEl.style.display = mode === "choosing" ? "flex" : "none";
      lineOptionsEl.style.display = DRONE_LINE_OPTION_MODES.indexOf(mode) !== -1 ? "block" : "none";
      orbitOptionsEl.style.display = DRONE_ORBIT_OPTION_MODES.indexOf(mode) !== -1 ? "block" : "none";
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
      showToast("궤도가 너무 작습니다. 다시 그려주세요.", true);
    },
    onFinished() {
      showToast("드론 비행이 끝났습니다.");
    },
  });

  btnToggle.onclick = () => {
    document.getElementById("info-card").classList.remove("visible");
    drone.startChoosing();
  };

  btnLine.onclick = () => {
    // 슬라이더 초기값을 드론 컨트롤에도 동기화해둔다.
    drone.setLineStartAltitude(Number(lineStartAltitudeInput.value));
    drone.setLineEndAltitude(Number(lineEndAltitudeInput.value));
    drone.chooseLine();
  };
  btnOrbit.onclick = () => {
    drone.setOrbitAltitude(Number(orbitAltitudeInput.value));
    drone.setLookAtAltitude(Number(centerAltitudeInput.value));
    drone.chooseOrbit();
  };

  btnPlay.onclick = () => {
    if (drone.getMode() === "playing") drone.pause();
    else drone.play();
  };

  // 다시 그리기는 직선뷰/회전뷰를 다시 고르는 단계로 돌아간다.
  btnRedraw.onclick = () => drone.startChoosing();

  btnExit.onclick = () => drone.exit();

  lineStartAltitudeInput.addEventListener("input", () => {
    const m = Number(lineStartAltitudeInput.value);
    lineStartAltitudeValue.textContent = m;
    drone.setLineStartAltitude(m);
  });

  lineEndAltitudeInput.addEventListener("input", () => {
    const m = Number(lineEndAltitudeInput.value);
    lineEndAltitudeValue.textContent = m;
    drone.setLineEndAltitude(m);
  });

  orbitAltitudeInput.addEventListener("input", () => {
    const m = Number(orbitAltitudeInput.value);
    orbitAltitudeValue.textContent = m;
    drone.setOrbitAltitude(m);
  });

  centerAltitudeInput.addEventListener("input", () => {
    const m = Number(centerAltitudeInput.value);
    centerAltitudeValue.textContent = m;
    drone.setLookAtAltitude(m);
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

// 주의: vworld는 UI 버튼 클릭에도 자체적으로 반응해서(같은 클릭 이벤트에 얹혀) 카메라를
// 살짝 움직이는 내부 동작이 있는 것으로 실측 확인됐다(정확한 내부 로직은 알 수 없음).
// stopPropagation으로는 우리 자신의 버튼 핸들러까지 막혀버려서, 대신 우리 쪽 카메라 이동을
// 이 이벤트 틱이 끝난 뒤로 살짝 미뤄서(setTimeout) 항상 우리가 마지막에 최종 시점을 확정한다.
function runCameraActionAfterClickSettles(fn) {
  setTimeout(fn, 150);
}

window.addEventListener("DOMContentLoaded", bootstrap);
