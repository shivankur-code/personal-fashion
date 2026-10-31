// Self-contained page (no external scripts, fonts or images). Images are resized in the browser
// to at most 1024 px before upload, which keeps requests small and FLUX.2 cost at its minimum.
export const TRY_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stylist – Try it</title>
<style>
  :root { --bg:#fafaf8; --fg:#1d1d1b; --muted:#6b6b66; --line:#e2e1dc; --accent:#1f4e8c; --card:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151514; --fg:#ecebe6; --muted:#a3a29b; --line:#33332f; --accent:#7fa8e0; --card:#1e1e1c; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
  main { max-width:980px; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:24px; margin:0 0 4px; }
  p.lead { color:var(--muted); margin:0 0 20px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .card h2 { font-size:15px; margin:0 0 8px; }
  .drop { border:1.5px dashed var(--line); border-radius:8px; min-height:180px; display:flex; align-items:center; justify-content:center; text-align:center; color:var(--muted); padding:8px; cursor:pointer; position:relative; }
  .drop img { max-width:100%; max-height:260px; border-radius:6px; }
  .thumbs { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
  .thumbs img { height:90px; border-radius:6px; border:1px solid var(--line); }
  input[type=file] { display:none; }
  label.small { font-size:13px; color:var(--muted); display:block; margin:12px 0 4px; }
  input[type=text], input[type=password] { width:100%; padding:10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font-size:15px; }
  button { margin-top:16px; width:100%; padding:12px; border:0; border-radius:8px; background:var(--accent); color:#fff; font-size:16px; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.6; cursor:wait; }
  .status { margin-top:10px; font-size:14px; color:var(--muted); min-height:20px; }
  .status.err { color:#c0392b; }
  #result img { width:100%; border-radius:8px; }
  .link { background:none; color:var(--accent); width:auto; padding:0; margin:8px 0 0; font-size:13px; font-weight:500; }
</style>
</head>
<body>
<main>
  <h1>Try it on</h1>
  <p class="lead">Add a full-length photo of yourself and up to <span id="maxG2">3</span> garments. Each garment is put on in its own step. Photos are used for this one request and not stored.</p>
  <div class="grid">
    <section class="card">
      <h2>1. Your photo</h2>
      <div class="drop" id="personDrop">Click to choose a full-length photo<br>(standing, facing the camera)</div>
      <input type="file" id="personFile" accept="image/*">
    </section>
    <section class="card">
      <h2>2. Garments (1–<span id="maxG">3</span>)</h2>
      <div class="drop" id="garmentDrop">Click to choose, or paste an image<br>(on Amazon: right-click the product image → Copy image, then Ctrl+V here)</div>
      <input type="file" id="garmentFile" accept="image/*" multiple>
      <div class="thumbs" id="garmentThumbs"></div>
      <button class="link" id="clearGarments" type="button">Clear garments</button>
    </section>
    <section class="card">
      <h2>3. Try on</h2>
      <label class="small" for="note">Styling note (optional)</label>
      <input type="text" id="note" maxlength="200" placeholder="e.g. blazer worn open, sleeves rolled">
      <label class="small" for="code">Access code</label>
      <input type="password" id="code" autocomplete="current-password">
      <button id="go" type="button">Try on</button>
      <div class="status" id="status"></div>
    </section>
  </div>
  <section class="card" id="result" style="margin-top:16px; display:none"><h2>Result</h2><div id="resultBody"></div></section>
</main>
<script>
(function () {
  var person = null, garments = [], maxG = 3;
  fetch('/v1/config').then(function (r) { return r.json(); }).then(function (c) { maxG = c.maxGarments || 3; document.getElementById('maxG').textContent = maxG; document.getElementById('maxG2').textContent = maxG; }).catch(function () {});
  var $ = function (id) { return document.getElementById(id); };
  var codeBox = $('code');
  try { codeBox.value = localStorage.getItem('stylist-code') || ''; } catch (e) {}

  function resize(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var max = 1024, s = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/jpeg', 0.88));
      };
      img.onerror = function () { reject(new Error('Could not read that image.')); };
      img.src = URL.createObjectURL(file);
    });
  }
  function status(msg, err) { var s = $('status'); s.textContent = msg; s.className = 'status' + (err ? ' err' : ''); }
  function showPerson(d) { person = d; $('personDrop').innerHTML = '<img alt="Your photo">'; $('personDrop').firstChild.src = d; }
  function addGarment(d) {
    if (garments.length >= maxG) { status('Up to ' + maxG + ' garments.', true); return; }
    garments.push(d); var i = new Image(); i.alt = 'Garment ' + garments.length; i.src = d; $('garmentThumbs').appendChild(i);
  }

  $('personDrop').onclick = function () { $('personFile').click(); };
  $('garmentDrop').onclick = function () { $('garmentFile').click(); };
  $('personFile').onchange = function (e) { var f = e.target.files[0]; if (f) resize(f).then(showPerson, function (x) { status(x.message, true); }); };
  $('garmentFile').onchange = function (e) {
    Array.prototype.slice.call(e.target.files, 0, maxG).forEach(function (f) { resize(f).then(addGarment, function (x) { status(x.message, true); }); });
  };
  $('clearGarments').onclick = function () { garments = []; $('garmentThumbs').innerHTML = ''; };
  document.addEventListener('paste', function (e) {
    var items = (e.clipboardData || {}).items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) {
        var f = items[i].getAsFile();
        resize(f).then(person ? addGarment : showPerson, function (x) { status(x.message, true); });
        status(person ? 'Garment added from clipboard.' : 'Photo added from clipboard.');
      }
    }
  });

  $('go').onclick = function () {
    if (!person) return status('Add your photo first.', true);
    if (!garments.length) return status('Add at least one garment.', true);
    if (!codeBox.value) return status('Enter the access code.', true);
    try { localStorage.setItem('stylist-code', codeBox.value); } catch (e) {}
    $('go').disabled = true; status('Rendering one garment at a time… about ' + (10 + garments.length * 15) + ' seconds.');
    var t0 = Date.now();
    fetch('/v1/try-on', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: codeBox.value, person: person, garments: garments, note: $('note').value })
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (x) {
        if (!x.ok) throw new Error(x.b.error || 'Something went wrong.');
        $('result').style.display = 'block';
        $('resultBody').innerHTML = '<img alt="Try-on result">';
        $('resultBody').firstChild.src = x.b.image;
        (x.b.notes || []).forEach(function (n) { var p = document.createElement('p'); p.className = 'status'; p.textContent = n; $('resultBody').appendChild(p); });
        status('Done in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s · about $' + x.b.estimatedCostUsd.toFixed(2) + ' · ' + x.b.remainingToday + ' left today. Right-click the image to save it.');
      })
      .catch(function (e) { status(e.message, true); })
      .then(function () { $('go').disabled = false; });
  };
})();
</script>
</body>
</html>`;
