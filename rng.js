var SoundingGen = SoundingGen || {};

SoundingGen.Rng = (function () {
  function xmur3(str) {
    var h = 1779033703 ^ str.length;
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }

  function Rng(seed) {
    var s = xmur3(String(seed))();
    this.state = s >>> 0;
    this.spare = null;
  }

  Rng.prototype.u = function () {
    var t = (this.state += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Rng.prototype.uni = function (a, b) { return a + (b - a) * this.u(); };
  Rng.prototype.int = function (a, b) { return Math.floor(this.uni(a, b + 1)); };
  Rng.prototype.chance = function (p) { return this.u() < p; };
  Rng.prototype.gauss = function () {
    if (this.spare !== null) { var s = this.spare; this.spare = null; return s; }
    var u, v, q;
    do { u = 2 * this.u() - 1; v = 2 * this.u() - 1; q = u * u + v * v; } while (q >= 1 || q === 0);
    var f = Math.sqrt(-2 * Math.log(q) / q);
    this.spare = v * f;
    return u * f;
  };
  Rng.prototype.norm = function (m, s) { return m + s * this.gauss(); };
  Rng.prototype.tnorm = function (m, s, lo, hi) {
    for (var i = 0; i < 20; i++) {
      var x = this.norm(m, s);
      if (x >= lo && x <= hi) return x;
    }
    return Math.min(hi, Math.max(lo, m));
  };
  Rng.prototype.range = function (r) { return this.uni(r[0], r[1]); };
  Rng.prototype.tri = function (a, c, b) {
    var u = this.u(), f = (c - a) / (b - a);
    return u < f ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
  };
  Rng.prototype.pick = function (arr) { return arr[Math.floor(this.u() * arr.length)]; };
  Rng.prototype.wpick = function (items, weightKey) {
    var tot = 0, i;
    for (i = 0; i < items.length; i++) tot += items[i][weightKey];
    var r = this.u() * tot;
    for (i = 0; i < items.length; i++) { r -= items[i][weightKey]; if (r <= 0) return items[i]; }
    return items[items.length - 1];
  };
  Rng.prototype.fork = function (tag) { return new Rng(this.state + ':' + tag); };

  return Rng;
})();
