"use strict";
import {DicePreset} from './DicePreset.js'
import {MATERIALTYPES} from "./const/materialtypes.js"
import {DICE_GEOM} from "./const/dice.js"

import * as THREE from "three"
import * as CANNON from "cannon-es"

const defaultConfig = {
	baseScale: 100,
	bumpMapping: true
}

// True if a multi-digit label reads as a different label on the same die when
// upside down, such as 16 / 91 on a d100. Those faces get an underline.
const UPSIDE_DOWN_DIGITS = {'0': '0', '1': '1', '6': '9', '8': '8', '9': '6'};
function readsDifferentlyUpsideDown(label, labels) {
	if (!/^[01689]+$/.test(label)) return false;
	const rotated = label.split('').reverse().map(c => UPSIDE_DOWN_DIGITS[c]).join('');
	return rotated !== label && labels.includes(rotated);
}

// Fit a label as large as possible inside a triangular face (used by the d100).
// The face's texture triangle comes from make_geom: its corners lie on a circle of
// radius 0.5 / (1 + tab) (in texture units) around the centre, at angles
// af + k * 120deg. Textures are flipped vertically when applied, and the text is
// drawn rotated by `rotation` degrees, so the triangle is mapped into that frame.
// Returns the font size and the point to draw at (textAlign center, baseline middle).
// Pass `size` to lay the label out at a fixed size instead of searching for one.
function fitLabelInTriangle(context, text, ts, { tab, af, rotation, fontFor, underline, margin, size }) {
	const c = ts / 2;
	const radius = ts * 0.5 / (1 + tab);
	const rot = -rotation * Math.PI / 180;
	const corners = [0, 1, 2].map(k => {
		const a = af + k * 2 * Math.PI / 3;
		const x = radius * Math.cos(a), y = -radius * Math.sin(a);
		return [c + x * Math.cos(rot) - y * Math.sin(rot), c + x * Math.sin(rot) + y * Math.cos(rot)];
	});
	const [A, B, C] = corners;
	const orient = Math.sign((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]));
	const inside = ([px, py]) => [[A, B], [B, C], [C, A]].every(([p, q]) => {
		const ex = q[0] - p[0], ey = q[1] - p[1];
		return orient * (ex * (py - p[1]) - ey * (px - p[0])) / Math.hypot(ex, ey) >= margin;
	}) && px >= margin && py >= margin && px <= ts - margin && py <= ts - margin;

	const layout = (size) => {
		context.font = fontFor(size);
		const m = context.measureText(text);
		const left = m.actualBoundingBoxLeft ?? m.width / 2;
		const right = m.actualBoundingBoxRight ?? m.width / 2;
		const ascent = m.actualBoundingBoxAscent ?? size * 0.7;
		const descent = m.actualBoundingBoxDescent ?? size * 0.7;
		const height = ascent + descent;
		const gap = underline ? height * 0.1 : 0;
		const thickness = underline ? Math.max(2, height * 0.1) : 0;
		// Centre the whole block (text plus any underline) on the face centre.
		const x = c + (left - right) / 2;
		const y = c + (ascent - descent - gap - thickness) / 2;
		const box = [x - left, y - ascent, x + right, y + descent + gap + thickness];
		return { size, x, y, box, width: left + right, underlineY: y + descent + gap, thickness };
	};
	const fits = ({ box: [x0, y0, x1, y1] }) => [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].every(inside);

	if (size) {
		const fixed = layout(size);
		context.font = fontFor(size);
		return fixed;
	}

	let lo = 1, hi = ts, best = layout(lo);
	for (let i = 0; i < 20; i++) {
		const mid = (lo + hi) / 2, l = layout(mid);
		if (fits(l)) { best = l; lo = mid; } else { hi = mid; }
	}
	context.font = fontFor(best.size);
	return best;
}

class DiceFactory {
	static dice = {}
	constructor(options) {
		// this.dice = {};
		this.geometries = {};

		this.materials_cache = {};
		this.cache_hits = 0;
		this.cache_misses = 0;

		this.label_color = '';
		this.dice_color = '';
		this.edge_color = '';
		this.label_outline = '';
		this.dice_texture = '';
		this.dice_material = '';

		this.material_options = {
			specular: 0xffffff,
			color: 0xb5b5b5,
			shininess: 5,
			flatShading: true
		};

		Object.assign(this, defaultConfig, options)
	}

	updateConfig(options = {}){
		Object.assign(this,options)
		if(options.scale){
			this.scaleGeometry()
		}
	}

	setBumpMapping(bumpMapping){
		this.bumpMapping = bumpMapping;
		this.materials_cache = {};
	}

	// returns a dicemesh (THREE.Mesh) object
	create(type) {
		let diceobj = this.get(type);
		if (!diceobj) return null;

		let geom = this.geometries[type];
		if(!geom) {
			geom = this.createGeometry(diceobj.shape, diceobj.scale * this.baseScale);
			this.geometries[type] = geom;
		}
		if (!geom) return null;

		this.setMaterialInfo();

		let dicemesh = new THREE.Mesh(geom, this.createMaterials(diceobj, this.baseScale / 2, 1.0));
		dicemesh.result = [];
		dicemesh.shape = diceobj.shape;
		dicemesh.rerolls = 0;
		dicemesh.resultReason = 'natural';
		dicemesh.mass = diceobj.mass

		dicemesh.getFaceValue = function() {
			// callback function. scope of this = Mesh
			let reason = this.resultReason;
			let vector = new THREE.Vector3(0, 0, this.shape == 'd4' ? -1 : 1);

			let closest_face, closest_angle = Math.PI * 2;
			let normals = this.geometry.getAttribute('normal').array;
			for (let i = 0, l = this.geometry.groups.length; i < l; ++i) {
				let face = this.geometry.groups[i];
				if (face.materialIndex == 0) continue;

				// face.start counts vertices (or index entries, for indexed geometry like
				// the d2); the normals array has 3 floats per vertex.
				const index = this.geometry.index;
				let startVertex = (index ? index.array[face.start] : face.start) * 3;
				let normal = new THREE.Vector3(normals[startVertex], normals[startVertex + 1], normals[startVertex + 2]);
				let angle = normal.clone().applyQuaternion(this.body.quaternion).angleTo(vector);
				if (angle < closest_angle) {
					closest_angle = angle;
					closest_face = face;
				}
			}
			let matindex = closest_face.materialIndex - 1;
			let offset = 2

			const diceobj = DiceFactory.dice[this.notation.type];

			if (this.shape == 'd4') {
				let labelindex2 = ((matindex-1) == 0) ? 5 : matindex;

				return {value: matindex, label: diceobj.labels[matindex-1][labelindex2][0], reason: reason};
			}

			if (this.shape == 'd10') {
				matindex += 1;
				offset -= 1;
			}
         if (this.shape == 'd2') {
            offset -= 1;
            matindex += 2; 
         }

			let value = diceobj.values[((matindex-1) % diceobj.values.length)];
			let label = diceobj.labels[(((matindex-1) % (diceobj.labels.length-2))+offset)];
			
			return {value: value, label: label, reason: reason};
		}

		dicemesh.storeRolledValue = function(reason) {
			this.resultReason = reason || this.resultReason;
			this.result.push(this.getFaceValue());
		}

		dicemesh.getLastValue = function() {
			if (!this.result || this.result.length < 1) return {value: undefined, label: '', reason: ''};

			return this.result[this.result.length-1];
		}

		dicemesh.ignoreLastValue = function(ignore) {
			let lastvalue = this.getLastValue();
			if (lastvalue.value === undefined) return;

			lastvalue.ignore = ignore;
			this.setLastValue(lastvalue);
		}

		dicemesh.setLastValue = function(result) {
			if (!this.result || this.result.length < 1) return;
			if (!result || result.length < 1) return;

			return this.result[this.result.length-1] = result;
		}

		if (diceobj.color) {
			dicemesh.material[0].color = new THREE.Color(diceobj.color);
			dicemesh.material[0].emissive = new THREE.Color(diceobj.color);
			dicemesh.material[0].emissiveIntensity = 1;
			dicemesh.material[0].needsUpdate = true;
		}

		switch (diceobj.values.length) {
			case 1:
				return this.fixmaterials(dicemesh, 1);
			case 2:
				return this.fixmaterials(dicemesh, 2);
			case 3: 
				return this.fixmaterials(dicemesh, 3);
			default:
				return dicemesh;
		}
	}

	get(type) {
		let dieSet
		if(DiceFactory.dice.hasOwnProperty(type)){
			dieSet = DiceFactory.dice[type]
		} else {
			dieSet = new DicePreset(type)
			DiceFactory.dice[type] = dieSet;
		}

		return dieSet
	}

	getGeometry(type) {
		return this.geometries[type];
	}

	scaleGeometry(){
		// console.log('this.geometries :>> ', this.geometries);
		// Object.entries(this.geometries).forEach(([key,geom]) => {
		// 	geom.scale(this.scale,this.scale,this.scale)
		// 	// remove cannon shape
		// 	// geom.cannon_shape.body.removeShape(geom.cannon_shape.body.shapes[0])
		// 	// recreate cannon shape with new scale
		// 	const newShape = this.createGeometry(key, this.scale, true)
		// 	console.log("🚀 ~ Object.entries ~ newShape", newShape)
		// 	geom.cannon_shape= newShape

		// })
	}

	createMaterials(diceobj, size, margin, allowcache = true, d4specialindex = 0) {

		let materials = [];
		let labels = diceobj.labels;
		if (diceobj.shape == 'd4') {
			labels = diceobj.labels[d4specialindex];
			size = this.baseScale / 2;
			margin = this.baseScale * 2;
		}
		
		for (var i = 0; i < labels.length; ++i) {
			var mat;
			if (this.dice_material != 'none') {
				mat = new THREE.MeshStandardMaterial(MATERIALTYPES[this.dice_material]);
				mat.envMapIntensity = 0;
			} else {
				mat = new THREE.MeshPhongMaterial(this.material_options);
			}

			let canvasTextures;
			if (i==0) { //edge
				//if the texture is fully opaque, we do not use it for edge
				let texture = {name:"none"};
				if(this.dice_texture_rand.composite != "source-over") texture = this.dice_texture_rand;

				canvasTextures = this.createTextMaterial(diceobj, labels, i, size, margin, texture, this.label_color_rand, this.label_outline_rand, this.edge_color_rand, allowcache);
				mat.map = canvasTextures.composite;

			} else {
				canvasTextures = this.createTextMaterial(diceobj, labels, i, size, margin, this.dice_texture_rand, this.label_color_rand, this.label_outline_rand, this.dice_color_rand, allowcache);
				mat.map = canvasTextures.composite;

				if (this.bumpMapping) {
					if (false) {
						mat.bumpScale = 0.5;
					} else {
						let scale = 0.75;;
						if(size > 35)
							scale = 1;
						if(size > 40)
							scale = 2.5;
						if(size > 45)
							scale = 4;
						mat.bumpScale = scale;
					}

					if (canvasTextures.bump) {
						mat.bumpMap = canvasTextures.bump;
					}
					if (diceobj.shape != 'd4' && diceobj.normals[i]) {
						mat.bumpMap = new THREE.Texture(diceobj.normals[i]);
						mat.bumpScale = 4;
						mat.bumpMap.needsUpdate = true;
					}
				}
			}
			mat.opacity = 1;
			mat.transparent = true;
			mat.depthTest = false;
			mat.needUpdate = true;
			materials.push(mat);
		}
		//Edge mat

		return materials;
	}

	createTextMaterial(diceobj, labels, index, size, margin, texture, forecolor, outlinecolor, backcolor, allowcache) {
		if (labels[index] === undefined) return null;

		texture = texture || this.dice_texture_rand;
		forecolor = forecolor || this.label_color_rand;
		outlinecolor = outlinecolor || this.label_outline_rand;
		backcolor = backcolor || this.dice_color_rand;
		allowcache = allowcache == undefined ? true : allowcache;

		let text = labels[index];
		let isTexture = false;
		let textCache = text;
		if (text instanceof HTMLImageElement) {
			textCache = text.src;
		} else if (text instanceof Array) {
			text.forEach(el => {
				textCache += el.src;
			});
		}

		// an attempt at materials caching
		const textureOpacity = this.dice_texture_opacity ?? 1;
		let cachestring = diceobj.type + textCache + index + texture.name + textureOpacity + forecolor + outlinecolor + backcolor;
		if (diceobj.shape == 'd4') {
			cachestring = diceobj.type + textCache + texture.name + textureOpacity + forecolor + outlinecolor + backcolor;
		}
		if (allowcache && this.materials_cache[cachestring] != null) {
			this.cache_hits++;
			return this.materials_cache[cachestring];
		}

		const doc = this.doc || document;
		let canvas = doc.createElement("canvas");
		let context = canvas.getContext("2d", {alpha: true});

		context.globalAlpha = 0;
		context.clearRect(0, 0, canvas.width, canvas.height);

		let canvasBump = doc.createElement("canvas");
		let contextBump = canvasBump.getContext("2d", {alpha: true});
		contextBump.globalAlpha = 0;
		contextBump.clearRect(0, 0, canvasBump.width, canvasBump.height);

		let ts;

		if (diceobj.shape == 'd4') {
			ts = this.calc_texture_size(size + margin) * 4;
		} else {
			ts = this.calc_texture_size(size + size * 2 * margin) * 4;
		}

		// 100 faces need 100 textures; half size keeps memory reasonable.
		if (diceobj.shape == 'd100') ts = ts / 2;

		canvas.width = canvas.height = ts;
		canvasBump.width = canvasBump.height = ts;

		// create color
		context.fillStyle = backcolor;
		context.fillRect(0, 0, canvas.width, canvas.height);

		contextBump.fillStyle = "#FFFFFF";
		contextBump.fillRect(0, 0, canvasBump.width, canvasBump.height);

		//create underlying texture
		if (texture.texture && texture.name != '' && texture.name != 'none') {
			const composite = texture.composite || 'source-over';
			let source = texture.texture;
			let alpha = textureOpacity;

			// Transparent textures cut their alpha into the dice ('destination-in').
			// Fading them with globalAlpha would fade the whole die, so instead build a
			// mask whose alpha blends from fully solid (opacity 0) to the texture's own
			// alpha (opacity 1): mask alpha = (1 - opacity) + opacity * texture alpha.
			if (composite === 'destination-in' && textureOpacity < 1) {
				const mask = doc.createElement("canvas");
				mask.width = canvas.width;
				mask.height = canvas.height;
				const maskContext = mask.getContext("2d", {alpha: true});
				maskContext.globalAlpha = 1 - textureOpacity;
				maskContext.fillStyle = "#000000";
				maskContext.fillRect(0, 0, mask.width, mask.height);
				maskContext.globalCompositeOperation = 'lighter';
				maskContext.globalAlpha = textureOpacity;
				maskContext.drawImage(texture.texture, 0, 0, mask.width, mask.height);
				source = mask;
				alpha = 1;
			}

			context.globalCompositeOperation = composite;
			context.globalAlpha = alpha;
			context.drawImage(source, 0, 0, canvas.width, canvas.height);
			context.globalAlpha = 1;
			context.globalCompositeOperation = 'source-over';

			if (texture.bump) {
				contextBump.globalCompositeOperation = 'source-over';
				contextBump.globalAlpha = textureOpacity;
				contextBump.drawImage(texture.bump, 0, 0, canvas.width, canvas.height);
				contextBump.globalAlpha = 1;
			}
		} else {
			context.globalCompositeOperation = 'source-over';
		}

		// create text
		context.globalCompositeOperation = 'source-over';
		context.textAlign = "center";
		context.textBaseline = "middle";

		contextBump.textAlign = "center";
		contextBump.textBaseline = "middle";

		if (diceobj.shape != 'd4') {

			// fixes texture rotations on specific dice models
			const rotate = {
				d8: {even: -7.5, odd: -127.5},
				d10: {all: -6},
				d12: {all: 5},
				d20: {all: -7.5},
				d100: {all: -7.5},
			};

			// fix for some faces being weirdly rotated
			let rotateface = rotate[diceobj.shape];
			if(rotateface) {
				let degrees
				if(rotateface.hasOwnProperty("all")){
					degrees = rotateface.all
				} else {
					if(index > 0 && (index % 2) != 0){
						degrees = rotateface.odd
					} else {
						degrees = rotateface.even
					}
				} 
				// let degrees = ((rotateface.hasOwnProperty("all") ? rotateface.all : false) || (index > 0 && (index % 2) != 0)) ? rotateface.odd : rotateface.even;

				if (degrees && degrees != 0) {

					var hw = (canvas.width / 2);
					var hh = (canvas.height / 2);

					context.translate(hw, hh);
					context.rotate(degrees * (Math.PI / 180));
					context.translate(-hw, -hh);

					contextBump.translate(hw, hh);
					contextBump.rotate(degrees * (Math.PI / 180));
					contextBump.translate(-hw, -hh);
				}
			}

			//custom texture face
			if (text instanceof HTMLImageElement) {
				isTexture = true;
				context.drawImage(text, 0,0,text.width,text.height,0,0,canvas.width,canvas.height);

			// text-only face
			} else {

				let fontsize = ts / (1 + 2 * margin);
				let textstarty = (canvas.height / 2) + 10;
				let textstartx = (canvas.width / 2);

				if(diceobj.shape == 'd10') {
					fontsize = fontsize*0.75;
					textstarty = (textstarty*1.15) - 10;
				} else if(diceobj.shape == 'd20') {
					textstartx = textstartx*0.98;
				}

				// Bold, and as large as the triangle allows, on the d100's small faces.
				const fontWeight = diceobj.shape == 'd100' ? 'bold ' : '';
				let fitted = null;
				if (diceobj.shape == 'd100' && !text.includes("\n")) {
					const fitOptions = (label) => ({
						tab: -0.2, af: -Math.PI / 4 / 2, rotation: rotate.d100.all,
						fontFor: size => fontWeight + size + 'pt ' + diceobj.font,
						underline: readsDifferentlyUpsideDown(label.trim(), labels),
						margin: ts * 0.03,
					});
					// Every number uses the same size: the largest at which every label fits.
					// Worked out once per die type and texture size.
					const sizeKey = diceobj.type + ts + diceobj.font;
					this.uniformLabelSize = this.uniformLabelSize || {};
					if (!this.uniformLabelSize[sizeKey]) {
						this.uniformLabelSize[sizeKey] = Math.min(...labels
							.filter(label => typeof label == 'string' && label.trim() != '')
							.map(label => fitLabelInTriangle(context, label, ts, fitOptions(label)).size));
					}
					fitted = fitLabelInTriangle(context, text, ts, {
						...fitOptions(text),
						size: this.uniformLabelSize[sizeKey],
					});
					fontsize = fitted.size;
					textstartx = fitted.x;
					textstarty = fitted.y;
				}

				context.font =  fontWeight + fontsize+ 'pt '+diceobj.font;
				contextBump.font =  fontWeight + fontsize+ 'pt '+diceobj.font;

				let lineHeight = context.measureText("M").width * 1.4;
				let textlines = text.split("\n");


				if (textlines.length > 1) {
					fontsize = fontsize / textlines.length;
					context.font =  fontsize+ 'pt '+diceobj.font;
					contextBump.font =  fontsize+ 'pt '+diceobj.font;
					lineHeight = context.measureText("M").width * 1.2;
					textstarty -= (lineHeight * textlines.length) / 2;
				}

				for(let i = 0, l = textlines.length; i < l; i++){
					let textline = textlines[i].trim();

					// attempt to outline the text with a meaningful color
					if (outlinecolor != 'none' && outlinecolor != backcolor) {
						context.strokeStyle = outlinecolor;
						context.lineWidth = 5;
						context.strokeText(textlines[i], textstartx, textstarty);

						contextBump.strokeStyle = "#000000";
						contextBump.lineWidth = 5;
						contextBump.strokeText(textlines[i], textstartx, textstarty);

						if (textline == '6' || textline == '9') {
							context.strokeText('  .', textstartx, textstarty);
							contextBump.strokeText('  .', textstartx, textstarty);
						}
					}

					context.fillStyle = forecolor;
					context.fillText(textlines[i], textstartx, textstarty);

					contextBump.fillStyle = "#000000";
					contextBump.fillText(textlines[i], textstartx, textstarty);

					if (textline == '6' || textline == '9') {
						context.fillText('  .', textstartx, textstarty);
						contextBump.fillText('  .', textstartx, textstarty);
					} else if (textline.length > 1 && readsDifferentlyUpsideDown(textline, labels)) {
						// Multi-digit labels like 16 / 91 get an underline instead of a dot.
						const width = fitted ? fitted.width : context.measureText(textline).width;
						const thickness = fitted ? fitted.thickness : Math.max(2, fontsize * 0.08);
						const y = fitted ? fitted.underlineY : textstarty + fontsize * 0.75;
						context.fillRect(textstartx - width / 2, y, width, thickness);
						contextBump.fillRect(textstartx - width / 2, y, width, thickness);
					}
					textstarty += (lineHeight * 1.5);
				}
			}
		} else {

			var hw = (canvas.width / 2);
			var hh = (canvas.height / 2);

			context.font =  (ts / 128 * 24)+'pt '+diceobj.font;
			contextBump.font =  (ts / 128 * 24)+'pt '+diceobj.font;

			//draw the numbers
			for (let i=0; i<text.length; i++) {
				//custom texture face
				if (text[i] instanceof HTMLImageElement) {
					let scaleTexture = text[i].width / canvas.width;
					context.drawImage(text[i], 0, 0, text[i].width, text[i].height, (100/scaleTexture), (25/scaleTexture), (60/scaleTexture), (60/scaleTexture));
				} else {
					// attempt to outline the text with a meaningful color
					if (outlinecolor != 'none' && outlinecolor != backcolor) {
						context.strokeStyle = outlinecolor;
						context.lineWidth = 5;
						context.strokeText(text[i], hw, hh - ts * 0.3);

						contextBump.strokeStyle = "#000000";
						contextBump.lineWidth = 5;
						contextBump.strokeText(text[i], hw, hh - ts * 0.3);
					}

					//draw label in top middle section
					context.fillStyle = forecolor;
					context.fillText(text[i], hw, hh - ts * 0.3);

					contextBump.fillStyle = "#000000";
					contextBump.fillText(text[i], hw, hh - ts * 0.3);
				}

				//rotate 1/3 for next label
				context.translate(hw, hh);
				context.rotate(Math.PI * 2 / 3);
				context.translate(-hw, -hh);

				contextBump.translate(hw, hh);
				contextBump.rotate(Math.PI * 2 / 3);
				contextBump.translate(-hw, -hh);
			}

			//debug side numbering
			// context.fillStyle = forecolor;
			// context.fillText(index, hw, hh);
		}

		var compositetexture = new THREE.CanvasTexture(canvas);
		var bumpMap;
		if (!isTexture) {
			bumpMap = new THREE.CanvasTexture(canvasBump);
		} else {
			bumpMap = null;
		}

		if (allowcache) {
			// cache new texture
			this.cache_misses++;
			this.materials_cache[cachestring] = {composite:compositetexture,bump:bumpMap};
		}

		return {composite:compositetexture,bump:bumpMap};
	}

	applyColorSet(colordata) {
		this.colordata = colordata;
		this.label_color = colordata.foreground;
		this.dice_color = colordata.background;
		this.label_outline = colordata.outline;
		this.dice_texture = colordata.texture;
		// How strongly the texture is drawn over the dice color, from 0 (none) to 1 (full).
		const opacity = Number(colordata.textureOpacity);
		this.dice_texture_opacity = Number.isFinite(opacity) ? Math.min(Math.max(opacity, 0), 1) : 1;
		this.dice_material = colordata?.texture?.material || 'none';
		this.edge_color = colordata.hasOwnProperty("edge") ? colordata.edge:colordata.background;
	}

	// pass in colorset data from dice-box
	setMaterialInfo(colorset = '') {
		let prevcolordata = this.colordata;
		let prevtexture = this.dice_texture;
		let prevmaterial = this.dice_material;

		//reset random choices
		this.dice_color_rand = '';
		this.label_color_rand = '';
		this.label_outline_rand = '';
		this.dice_texture_rand = '';
		this.dice_material_rand = '';
		this.edge_color_rand = '';

		// set base color first
		if (Array.isArray(this.dice_color)) {

			var colorindex = Math.floor(Math.random() * this.dice_color.length);

			// if color list and label list are same length, treat them as a parallel list
			if (Array.isArray(this.label_color) && this.label_color.length == this.dice_color.length) {
				this.label_color_rand = this.label_color[colorindex];

				// if label list and outline list are same length, treat them as a parallel list
				if (Array.isArray(this.label_outline) && this.label_outline.length == this.label_color.length) {
					this.label_outline_rand = this.label_outline[colorindex];
				}
			}
			// if texture list is same length do the same
			if (Array.isArray(this.dice_texture) && this.dice_texture.length == this.dice_color.length) {
				this.dice_texture_rand = this.dice_texture[colorindex];
				this.dice_material_rand = this.dice_texture_rand.material;
			}

			//if edge list and color list are same length, treat them as a parallel list
			if (Array.isArray(this.edge_color) && this.edge_color.length == this.dice_color.length) {
				this.edge_color_rand = this.edge_color[colorindex];
			}

			this.dice_color_rand = this.dice_color[colorindex];
		} else {
			this.dice_color_rand = this.dice_color;
		}

		// set edge color if not set
		if(this.edge_color_rand == ''){
			if (Array.isArray(this.edge_color)) {

				var colorindex = Math.floor(Math.random() * this.edge_color.length);

				this.edge_color_rand = this.edge_color[colorindex];
			} else {
				this.edge_color_rand = this.edge_color;
			}
		}

		// if selected label color is still not set, pick one
		if (this.label_color_rand == '' && Array.isArray(this.label_color)) {
			var colorindex = this.label_color[Math.floor(Math.random() * this.label_color.length)];

			// if label list and outline list are same length, treat them as a parallel list
			if (Array.isArray(this.label_outline) && this.label_outline.length == this.label_color.length) {
				this.label_outline_rand = this.label_outline[colorindex];
			}

			this.label_color_rand = this.label_color[colorindex];

		} else if (this.label_color_rand == '') {
			this.label_color_rand = this.label_color;
		}

		// if selected label outline is still not set, pick one
		if (this.label_outline_rand == '' && Array.isArray(this.label_outline)) {
			var colorindex = this.label_outline[Math.floor(Math.random() * this.label_outline.length)];

			this.label_outline_rand = this.label_outline[colorindex];
			
		} else if (this.label_outline_rand == '') {
			this.label_outline_rand = this.label_outline;
		}

		// same for textures list
		if (this.dice_texture_rand == '' && Array.isArray(this.dice_texture)) {
			this.dice_texture_rand = this.dice_texture[Math.floor(Math.random() * this.dice_texture.length)];
			this.dice_material_rand = this.dice_texture_rand.material || this.dice_material;
		} else if (this.dice_texture_rand == '') {
			this.dice_texture_rand = this.dice_texture;
			this.dice_material_rand = this.dice_texture_rand.material || this.dice_material;
		}

		//apply material
		if (this.dice_material_rand == '' && Array.isArray(this.dice_material)) {
			this.dice_material_rand = this.dice_material[Math.floor(Math.random() * this.dice_material.length)];
		} else if (this.dice_material_rand == '') {
			this.dice_material_rand = this.dice_material;
		}

		// console.log('this.colordata', this.colordata)

		if (this.colordata &&this.colordata.id != prevcolordata.id) {
			this.applyColorSet(prevcolordata, prevtexture, prevmaterial);
			// this.applyTexture(prevtexture);
			// this.applyMaterial(prevmaterial);
		}
	}

	calc_texture_size(approx) {
		return Math.pow(2, Math.floor(Math.log(approx) / Math.log(2)));
	}

	createGeometry(type, radius, onlyShape = false) {
		const func = onlyShape ? "create_shape" : "create_geom"
		switch (type) {
			case 'd2':
				var geom = new THREE.CylinderGeometry(1*radius, 1*radius, 0.1*radius, 32);
				geom.cannon_shape = new CANNON.Cylinder(1*radius, 1*radius, 0.1*radius, 8);

				geom.clearGroups();

				geom.addGroup(0, 192, 0);
				geom.addGroup(192, 96, 1);
				geom.addGroup(288, 96, 2);
				return geom;
			case 'd4':
				return this[func](DICE_GEOM.d4.vertices, DICE_GEOM.d4.faces, radius, -0.1, Math.PI * 7 / 6, 0.96);
			case 'd6':
				return this[func](DICE_GEOM.d6.vertices, DICE_GEOM.d6.faces, radius, 0.1, Math.PI / 4, 0.96);
			case 'd8':
				return this[func](DICE_GEOM.d8.vertices, DICE_GEOM.d8.faces, radius, 0, -Math.PI / 4 / 2, 0.965);
			case 'd10':
				return this[func](DICE_GEOM.d10.vertices, DICE_GEOM.d10.faces, radius, 0.3, Math.PI, 0.945);
			case 'd12':
				return this[func](DICE_GEOM.d12.vertices, DICE_GEOM.d12.faces, radius, 0.2, -Math.PI / 4 / 2, 0.968);
			case 'd20':
				return this[func](DICE_GEOM.d20.vertices, DICE_GEOM.d20.faces, radius, -0.2, -Math.PI / 4 / 2, 0.955);
			case 'd100':
				// Triangular faces like the d20, so the same label mapping applies.
				return this[func](DICE_GEOM.d100.vertices, DICE_GEOM.d100.faces, radius, -0.2, -Math.PI / 4 / 2, 0.955);
			default:
				console.error(`Geometry for ${type} is not available`)
				return null;
		}
	}

	fixmaterials(mesh, unique_sides) {
		// this makes the mesh reuse textures for other sides
		for (let i = 0, l = mesh.geometry.groups.length; i < l; ++i) {
			var matindex = mesh.geometry.groups[i].materialIndex - 2;
			if (matindex < unique_sides) continue;

			let modmatindex = (matindex % unique_sides);

			mesh.geometry.groups[i].materialIndex = modmatindex + 2;
		}
		mesh.geometry.elementsNeedUpdate = true;
		return mesh;
	}

	create_shape(vertices, faces, radius) {
		var vectors = new Array(vertices.length);
		for (var i = 0; i < vertices.length; ++i) {
			vectors[i] = (new THREE.Vector3).fromArray(vertices[i]).normalize();
		}
		var cv = new Array(vertices.length), cf = new Array(faces.length);
		for (var i = 0; i < vectors.length; ++i) {
			var v = vectors[i];
			cv[i] = new CANNON.Vec3(v.x * radius, v.y * radius, v.z * radius);
		}
		for (var i = 0; i < faces.length; ++i) {
			cf[i] = faces[i].slice(0, faces[i].length - 1);
		}
		const shape = new CANNON.ConvexPolyhedron({vertices:cv,faces:cf});
		// console.log("🚀 ~ create_shape ~ shape", shape)
		return shape
	}

	make_geom(vertices, faces, radius, tab, af) {
		let geom = new THREE.BufferGeometry();

		for (let i = 0; i < vertices.length; ++i) {
				vertices[i] = vertices[i].multiplyScalar(radius);
		}

		let positions = [];
		const normals = [];
		const uvs = [];

		const cb = new THREE.Vector3();
		const ab = new THREE.Vector3();
		let materialIndex;
		let faceFirstVertexIndex = 0;

		for (let i = 0; i < faces.length; ++i) {
				let ii = faces[i], fl = ii.length - 1;
				let aa = Math.PI * 2 / fl;
				materialIndex = ii[fl] + 1;
				for (let j = 0; j < fl - 2; ++j) {

						//Vertices
						positions.push(...vertices[ii[0]].toArray());
						positions.push(...vertices[ii[j + 1]].toArray());
						positions.push(...vertices[ii[j + 2]].toArray());

						// Flat face normals
						cb.subVectors( vertices[ii[j + 2]], vertices[ii[j + 1]] );
						ab.subVectors( vertices[ii[0]], vertices[ii[j + 1]] );
						cb.cross( ab );
						cb.normalize();

						// Vertex Normals
						normals.push(...cb.toArray());
						normals.push(...cb.toArray());
						normals.push(...cb.toArray());

						//UVs
						uvs.push((Math.cos(af) + 1 + tab) / 2 / (1 + tab), (Math.sin(af) + 1 + tab) / 2 / (1 + tab));
						uvs.push((Math.cos(aa * (j + 1) + af) + 1 + tab) / 2 / (1 + tab), (Math.sin(aa * (j + 1) + af) + 1 + tab) / 2 / (1 + tab));
						uvs.push((Math.cos(aa * (j + 2) + af) + 1 + tab) / 2 / (1 + tab), (Math.sin(aa * (j + 2) + af) + 1 + tab) / 2 / (1 + tab));

				}

				//Set Group for face materials.
				let numOfVertices = (fl - 2) * 3;
				for (let i = 0; i < numOfVertices/3; i++) {
					geom.addGroup(faceFirstVertexIndex, 3, materialIndex);
					faceFirstVertexIndex += 3;
				}

		}


		geom.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
		geom.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );
		geom.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
		geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius);
		return geom;
	}

	make_d10_geom(vertices, faces, radius, tab, af) {
		let geom = new THREE.BufferGeometry();

		for (let i = 0; i < vertices.length; ++i) {
				vertices[i] = vertices[i].multiplyScalar(radius);
		}

		let positions = [];
		const normals = [];
		const uvs = [];

		const cb = new THREE.Vector3();
		const ab = new THREE.Vector3();
		let materialIndex;
		let faceFirstVertexIndex = 0;

		for (let i = 0; i < faces.length; ++i) {
			let ii = faces[i], fl = ii.length - 1;
			let aa = Math.PI * 2 / fl;
			materialIndex = ii[fl] + 1;
			var w = 0.65;
			var h = 0.85;
			var v0 = 1 - 1*h;
			var v1 = 1 - (0.895/1.105)*h;
			var v2 = 1;
			for (let j = 0; j < fl - 2; ++j) {

				//Vertices
				positions.push(...vertices[ii[0]].toArray());
				positions.push(...vertices[ii[j + 1]].toArray());
				positions.push(...vertices[ii[j + 2]].toArray());

				// Flat face normals
				cb.subVectors( vertices[ii[j + 2]], vertices[ii[j + 1]] );
				ab.subVectors( vertices[ii[0]], vertices[ii[j + 1]] );
				cb.cross( ab );
				cb.normalize();

				// Vertex Normals
				normals.push(...cb.toArray());
				normals.push(...cb.toArray());
				normals.push(...cb.toArray());

				//UVs
				if(faces[i][faces[i].length-1] == -1 || j >= 2){
					uvs.push((Math.cos(af) + 1 + tab) / 2 / (1 + tab), (Math.sin(af) + 1 + tab) / 2 / (1 + tab));
					uvs.push((Math.cos(aa * (j + 1) + af) + 1 + tab) / 2 / (1 + tab), (Math.sin(aa * (j + 1) + af) + 1 + tab) / 2 / (1 + tab));
					uvs.push((Math.cos(aa * (j + 2) + af) + 1 + tab) / 2 / (1 + tab), (Math.sin(aa * (j + 2) + af) + 1 + tab) / 2 / (1 + tab));
				} else if(j==0) {
					uvs.push(0.5-w/2, v1);
					uvs.push(0.5, v0);
					uvs.push(0.5+w/2, v1);
				} else if(j==1) {
					uvs.push(0.5-w/2, v1);
					uvs.push(0.5+w/2, v1);
					uvs.push(0.5, v2);
				}
			}
			//Set Group for face materials.
			let numOfVertices = (fl - 2) * 3;
			for (let i = 0; i < numOfVertices/3; i++) {
				geom.addGroup(faceFirstVertexIndex, 3, materialIndex);
				faceFirstVertexIndex += 3;
			}
		}


		geom.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
		geom.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );
		geom.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
		geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius);

		return geom;
	}

	chamfer_geom(vectors, faces, chamfer) {
		var chamfer_vectors = [], chamfer_faces = [], corner_faces = new Array(vectors.length);
		for (var i = 0; i < vectors.length; ++i) corner_faces[i] = [];
		for (var i = 0; i < faces.length; ++i) {
			var ii = faces[i], fl = ii.length - 1;
			var center_point = new THREE.Vector3();
			var face = new Array(fl);
			for (var j = 0; j < fl; ++j) {
				var vv = vectors[ii[j]].clone();
				center_point.add(vv);
				corner_faces[ii[j]].push(face[j] = chamfer_vectors.push(vv) - 1);
			}
			center_point.divideScalar(fl);
			for (var j = 0; j < fl; ++j) {
				var vv = chamfer_vectors[face[j]];
				vv.subVectors(vv, center_point).multiplyScalar(chamfer).addVectors(vv, center_point);
			}
			face.push(ii[fl]);
			chamfer_faces.push(face);
		}
		for (var i = 0; i < faces.length - 1; ++i) {
			for (var j = i + 1; j < faces.length; ++j) {
				var pairs = [], lastm = -1;
				for (var m = 0; m < faces[i].length - 1; ++m) {
					var n = faces[j].indexOf(faces[i][m]);
					if (n >= 0 && n < faces[j].length - 1) {
						if (lastm >= 0 && m != lastm + 1) pairs.unshift([i, m], [j, n]);
						else pairs.push([i, m], [j, n]);
						lastm = m;
					}
				}
				if (pairs.length != 4) continue;
				chamfer_faces.push([
					chamfer_faces[pairs[0][0]][pairs[0][1]],
					chamfer_faces[pairs[1][0]][pairs[1][1]],
					chamfer_faces[pairs[3][0]][pairs[3][1]],
					chamfer_faces[pairs[2][0]][pairs[2][1]],
					-1
				]);
			}
		}
		for (var i = 0; i < corner_faces.length; ++i) {
			var cf = corner_faces[i], face = [cf[0]], count = cf.length - 1;
			while (count) {
				for (var m = faces.length; m < chamfer_faces.length; ++m) {
					var index = chamfer_faces[m].indexOf(face[face.length - 1]);
					if (index >= 0 && index < 4) {
						if (--index == -1) index = 3;
						var next_vertex = chamfer_faces[m][index];
						if (cf.indexOf(next_vertex) >= 0) {
							face.push(next_vertex);
							break;
						}
					}
				}
				--count;
			}
			face.push(-1);
			chamfer_faces.push(face);
		}
		return { vectors: chamfer_vectors, faces: chamfer_faces };
	}

	create_geom(vertices, faces, radius, tab, af, chamfer) {
		var vectors = new Array(vertices.length);
		for (var i = 0; i < vertices.length; ++i) {
			vectors[i] = (new THREE.Vector3).fromArray(vertices[i]).normalize();
		}
		var cg = this.chamfer_geom(vectors, faces, chamfer);
		if(faces.length != 10) {
			var geom = this.make_geom(cg.vectors, cg.faces, radius, tab, af);
		}
		else {
			var geom = this.make_d10_geom(cg.vectors, cg.faces, radius, tab, af);
		}
		//var geom = make_geom(vectors, faces, radius, tab, af); // Without chamfer
		geom.cannon_shape = this.create_shape(vertices, faces, radius);
		geom.name = "d"+faces.length
		return geom;
	}

	destroy() {
		// Dispose of all cached materials and textures
		Object.keys(this.materials_cache).forEach(key => {
			const cached = this.materials_cache[key];
			if (cached.composite) {
				cached.composite.dispose();
			}
			if (cached.bump) {
				cached.bump.dispose();
			}
		});
		this.materials_cache = {};

		// Dispose of all geometries
		Object.keys(this.geometries).forEach(key => {
			const geom = this.geometries[key];
			if (geom && geom.dispose) {
				geom.dispose();
			}
		});
		this.geometries = {};

		// Reset cache statistics
		this.cache_hits = 0;
		this.cache_misses = 0;
	}
}

export { DiceFactory }
