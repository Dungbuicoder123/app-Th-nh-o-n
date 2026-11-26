// The bundled qrcode-generator 1.4.4 encoder runs entirely offline.
window.DoanQR = {
  generateQRSvg(text, pixelSize = 200) {
    const code = qrcode(0, "M");
    code.addData(String(text));
    code.make();
    const quiet = 4;
    const modules = code.getModuleCount();
    const size = modules + quiet * 2;
    const path = [];
    for (let row = 0; row < modules; row++) {
      for (let col = 0; col < modules; col++) {
        if (code.isDark(row, col)) path.push(`M${col + quiet} ${row + quiet}h1v1h-1z`);
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="white"/><path d="${path.join("")}"/></svg>`;
  }
};
