// 건물 입면(외벽) 클릭을 감지하고, 클릭된 지점의 절대 표고 + 지반고를 이용해
// 대략적인 층수를 추정한 뒤 콜백으로 넘겨준다.
// vworld의 map.onClick은 클릭 픽셀좌표({x,y})만 주므로, 실제 3D 피킹은
// 내부 Cesium 뷰어(scene.pick / scene.pickPosition)를 직접 사용한다.
// (map.pixelToCoord()는 vworld 번들 내부 참조 버그로 동작하지 않아 사용하지 않는다.)
//
// 주의: map.onClick은 사이드바/버튼 같은 UI를 눌러도 같이 발생한다. 대부분은 scene.pick이
// 빈 배경을 반환해 자연히 무시되지만, UI를 누른 시점의 vworld 내부 카메라 동작까지 막고
// 싶다면 main.js의 runCameraActionAfterClickSettles가 우리 쪽 카메라 이동을 그 뒤로
// 미뤄서 항상 마지막 상태를 우리가 확정하도록 되어 있다.
function enableBuildingViewPicker(viewer, map, onPicked) {
  map.onClick.addEventListener((evt) => {
    const windowPosition = { x: evt.x, y: evt.y };
    const picked = viewer.scene.pick(windowPosition);
    if (!picked) return; // 빈 하늘/배경 클릭은 무시

    const cartesian = viewer.scene.pickPosition(windowPosition);
    if (!cartesian) return;

    const geo = cartesianToGeodetic(viewer, cartesian);
    const groundHeight = sampleGroundHeight(viewer, geo.lon, geo.lat);
    const heightAboveGround = Math.max(0, geo.height - groundHeight);
    const estimatedFloor = Math.max(1, Math.round(heightAboveGround / FLOOR_HEIGHT_M) + 1);

    onPicked({
      lon: geo.lon,
      lat: geo.lat,
      cartesian,
      clickedHeight: geo.height,
      groundHeight,
      heightAboveGround,
      estimatedFloor,
    });
  });
}
