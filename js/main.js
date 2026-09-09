let viewer;
let vwMap;
let orbit;
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
      viewer.scene.screenSpaceCameraController.enableInputs = !viewpointModeActive;
    });

    enableBuildingViewPicker(viewer, vwMap, (picked) => {
      showInfoCard(picked);
    });

    setupSearchForm();
    setupOrbitSliders();
    setupDpadDrag();

    document.getElementById("btn-back").onclick = () => {
      const target = savedOverviewState;
      runCameraActionAfterClickSettles(() => flyToOverview(viewer, target));
      viewpointModeActive = false; // 전체보기: 마우스 조작 복원
      orbit = createOrbitControl(viewer);
      document.getElementById("btn-back").style.display = "none";
      document.getElementById("btn-view").style.display = "inline-block";
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

// 주의: vworld는 UI 버튼 클릭에도 자체적으로 반응해서(같은 클릭 이벤트에 얹혀) 카메라를
// 살짝 움직이는 내부 동작이 있는 것으로 실측 확인됐다(정확한 내부 로직은 알 수 없음).
// stopPropagation으로는 우리 자신의 버튼 핸들러까지 막혀버려서, 대신 우리 쪽 카메라 이동을
// 이 이벤트 틱이 끝난 뒤로 살짝 미뤄서(setTimeout) 항상 우리가 마지막에 최종 시점을 확정한다.
function runCameraActionAfterClickSettles(fn) {
  setTimeout(fn, 150);
}

window.addEventListener("DOMContentLoaded", bootstrap);
