var SoundingGen = SoundingGen || {};

SoundingGen.STATIONS = [
  { id: 'OUN', wmo: 72357, name: 'Norman, OK', lat: 35.18, lon: -97.44, elev: 357, region: 'sp', w: 1.6 },
  { id: 'FWD', wmo: 72249, name: 'Fort Worth, TX', lat: 32.83, lon: -97.30, elev: 171, region: 'sp', w: 1.3 },
  { id: 'DRT', wmo: 72261, name: 'Del Rio, TX', lat: 29.37, lon: -100.92, elev: 313, region: 'sp', w: 0.8 },
  { id: 'AMA', wmo: 72363, name: 'Amarillo, TX', lat: 35.23, lon: -101.71, elev: 1095, region: 'hp', w: 1.4 },
  { id: 'MAF', wmo: 72265, name: 'Midland, TX', lat: 31.95, lon: -102.19, elev: 873, region: 'hp', w: 1.1 },
  { id: 'DDC', wmo: 72451, name: 'Dodge City, KS', lat: 37.76, lon: -99.97, elev: 790, region: 'hp', w: 1.5 },
  { id: 'LBF', wmo: 72562, name: 'North Platte, NE', lat: 41.13, lon: -100.68, elev: 847, region: 'hp', w: 1.3 },
  { id: 'DNR', wmo: 72469, name: 'Denver, CO', lat: 39.77, lon: -104.87, elev: 1611, region: 'hp', w: 0.9 },
  { id: 'UNR', wmo: 72662, name: 'Rapid City, SD', lat: 44.07, lon: -103.21, elev: 1037, region: 'hp', w: 0.9 },
  { id: 'TOP', wmo: 72456, name: 'Topeka, KS', lat: 39.07, lon: -95.63, elev: 268, region: 'cp', w: 1.4 },
  { id: 'SGF', wmo: 72440, name: 'Springfield, MO', lat: 37.23, lon: -93.40, elev: 394, region: 'cp', w: 1.2 },
  { id: 'OAX', wmo: 72558, name: 'Omaha/Valley, NE', lat: 41.32, lon: -96.37, elev: 350, region: 'cp', w: 1.3 },
  { id: 'ABR', wmo: 72659, name: 'Aberdeen, SD', lat: 45.46, lon: -98.41, elev: 397, region: 'np', w: 1.0 },
  { id: 'BIS', wmo: 72764, name: 'Bismarck, ND', lat: 46.77, lon: -100.76, elev: 505, region: 'np', w: 0.8 },
  { id: 'MPX', wmo: 72649, name: 'Chanhassen, MN', lat: 44.85, lon: -93.57, elev: 287, region: 'np', w: 0.9 },
  { id: 'DVN', wmo: 74455, name: 'Davenport, IA', lat: 41.61, lon: -90.58, elev: 229, region: 'mw', w: 1.0 },
  { id: 'ILX', wmo: 74560, name: 'Lincoln, IL', lat: 40.15, lon: -89.34, elev: 178, region: 'mw', w: 1.0 },
  { id: 'GRB', wmo: 72645, name: 'Green Bay, WI', lat: 44.48, lon: -88.13, elev: 210, region: 'gl', w: 0.6 },
  { id: 'DTX', wmo: 72632, name: 'White Lake, MI', lat: 42.70, lon: -83.47, elev: 329, region: 'gl', w: 0.6 },
  { id: 'ILN', wmo: 72426, name: 'Wilmington, OH', lat: 39.42, lon: -83.82, elev: 317, region: 'ov', w: 0.8 },
  { id: 'BNA', wmo: 72327, name: 'Nashville, TN', lat: 36.25, lon: -86.56, elev: 210, region: 'ov', w: 0.9 },
  { id: 'LZK', wmo: 72340, name: 'Little Rock, AR', lat: 34.83, lon: -92.26, elev: 172, region: 'se', w: 1.0 },
  { id: 'SHV', wmo: 72248, name: 'Shreveport, LA', lat: 32.45, lon: -93.84, elev: 84, region: 'se', w: 0.9 },
  { id: 'JAN', wmo: 72235, name: 'Jackson, MS', lat: 32.32, lon: -90.08, elev: 91, region: 'se', w: 0.9 },
  { id: 'BMX', wmo: 72230, name: 'Birmingham, AL', lat: 33.17, lon: -86.77, elev: 178, region: 'se', w: 0.9 },
  { id: 'FFC', wmo: 72215, name: 'Peachtree City, GA', lat: 33.36, lon: -84.57, elev: 244, region: 'se', w: 0.6 },
  { id: 'LCH', wmo: 72240, name: 'Lake Charles, LA', lat: 30.12, lon: -93.22, elev: 5, region: 'gc', w: 0.7 },
  { id: 'CRP', wmo: 72251, name: 'Corpus Christi, TX', lat: 27.78, lon: -97.51, elev: 14, region: 'gc', w: 0.6 },
  { id: 'SPG', wmo: 72399, name: 'Spruce Springs', lat: 36.0, lon: -97.0, elev: 350, region: 'sp', w: 0 }
];

SoundingGen.REGION_NAMES = {
  sp: 'Southern Plains', hp: 'High Plains', cp: 'Central Plains', np: 'Northern Plains',
  mw: 'Midwest', gl: 'Great Lakes', ov: 'Ohio/Tennessee Valley', se: 'Southeast', gc: 'Gulf Coast'
};
