// Watches Hyprland keyboard layouts and shows the active one.

import { createState, onCleanup } from "ags"
import { execAsync } from "ags/process"

import { attemptAsync } from "$lib/result"
import { hyprland } from "$service/astal"

const LAYOUT_CODES: Record<string, string> = {
	"english": "en", "russian": "ru", "hebrew": "he", "arabic": "ar", "chinese": "zh",
	"japanese": "ja", "korean": "ko", "french": "fr", "german": "de", "spanish": "es",
	"italian": "it", "portuguese": "pt", "dutch": "nl", "polish": "pl", "turkish": "tr",
	"greek": "el", "ukrainian": "uk", "czech": "cs", "slovak": "sk", "hungarian": "hu",
	"romanian": "ro", "bulgarian": "bg", "croatian": "hr", "serbian": "sr", "slovene": "sl",
	"latvian": "lv", "lithuanian": "lt", "estonian": "et", "finnish": "fi", "swedish": "sv",
	"norwegian": "no", "danish": "da", "icelandic": "is", "thai": "th", "vietnamese": "vi",
	"hindi": "hi", "bengali": "bn", "tamil": "ta", "telugu": "te", "urdu": "ur",
	"persian": "fa", "farsi": "fa", "malayalam": "ml", "malagasy": "mg", "malay": "ms",
	"swahili": "sw", "yoruba": "yo", "zulu": "zu", "amharic": "am", "mongolian": "mn",
	"khmer": "km", "lao": "lo", "burmese": "my", "welsh": "cy", "irish": "ga",
	"basque": "eu", "catalan": "ca", "galician": "gl", "albanian": "sq", "macedonian": "mk",
	"bosnian": "bs", "montenegrin": "cnr", "belarusian": "be", "azerbaijani": "az",
	"georgian": "ka", "armenian": "hy", "kazakh": "kk", "kyrgyz": "ky", "uzbek": "uz",
	"tajik": "tg", "turkmen": "tk", "pashto": "ps", "dari": "prs", "kurdish": "ku",
	"afrikaans": "af", "akan": "ak", "bambara": "bm", "berber": "ber", "chuvash": "cv",
	"esperanto": "eo", "ewe": "ee", "faroese": "fo", "filipino": "fil", "friulian": "fur",
	"fulah": "ff", "gagauz": "gag", "igbo": "ig", "ido": "io", "indonesian": "id",
	"inuktitut": "iu", "javanese": "jv", "kannada": "kn", "kanuri": "kr", "kashmiri": "ks",
	"kikuyu": "ki", "kinyarwanda": "rw", "komi": "kv", "maltese": "mt", "maori": "mi",
	"marathi": "mr", "northern": "se", "yakut": "sah", "abkhazian": "ab", "asturian": "ast",
	"avatime": "avt", "cherokee": "chr", "crimean": "crh", "dhivehi": "dv",
}

async function queryKeyboardLayout(): Promise<string> {
	const result = await attemptAsync(async (): Promise<string> => {
		const output = (await execAsync("hyprctl devices -j")).trim()
		if (!output) return "err"

		const data = JSON.parse(output) as { keyboards?: Array<{ active_keymap?: string, main?: boolean }> }
		const keyboards = Array.isArray(data.keyboards) ? data.keyboards : []
		for (const keyboard of keyboards) {
			if (keyboard.main && typeof keyboard.active_keymap === "string" && keyboard.active_keymap.length > 0) {
				const keymap = keyboard.active_keymap.trim().split(/[\s(]/)[0].toLowerCase()
				return LAYOUT_CODES[keymap] || keymap
			}
		}
		return "unk"
	})

	if (!result.ok) {
		console.error("KeyboardLayout: " + result.err)
		return "err"
	}
	return result.value
}

export function KeyboardLayout() {
	const [layout, setLayout] = createState("")
	let active = true
	const update = () => void queryKeyboardLayout().then(value => {
		if (active) setLayout(value)
	})

	update()
	const connection = hyprland.connect("keyboard-layout", update)
	onCleanup(() => {
		active = false
		hyprland.disconnect(connection)
	})

	return <label label={layout} />
}
