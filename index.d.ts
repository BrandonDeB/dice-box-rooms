// Type declarations for the library.
// This file lives outside dist/ because `vite build` empties dist/ on every build.
// The types are deliberately loose: they name every export without describing every method.

type Loose = { [key: string]: any };

export declare class DiceBox {
	constructor(container: string | HTMLElement, options?: Loose);
	[key: string]: any;
}
export default DiceBox;

export declare class DiceColors {
	constructor(options?: Loose);
	[key: string]: any;
}

export declare class DiceFactory {
	constructor(options?: Loose);
	[key: string]: any;
}

export declare class DiceNotation {
	constructor(notation: string, generate?: boolean);
	set: { num: number; type: string; func?: string; [key: string]: any }[];
	setkeys: any[];
	groups: any[];
	op: string;
	constant: number | null;
	result: any[];
	error: boolean;
	boost: number;
	notation: string;
	vectors: any[];
	generate?: boolean;
	[key: string]: any;
}

export declare class DicePreset {
	constructor(type: string, shape?: string);
	[key: string]: any;
}

export declare const COLORSETS: Loose;
export declare const COLORCATEGORIES: Loose;
export declare const THEMES: Loose;
export declare const TEXTURELIST: Loose;
export declare const MATERIALTYPES: Loose;
export declare const DICE: Loose;
export declare const DICE_GEOM: Loose;
export declare const SYSTEMS: Loose;
export declare const BASE64TEXTURES: Loose;
