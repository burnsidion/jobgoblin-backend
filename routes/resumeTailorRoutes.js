import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import express from "express";
import getSupabaseClient from "../supabaseClient.js";
import authMiddleware from "../middleware/authMiddleware.js";
import multer from "multer";
import openaiClient from "../utils/openaiClient.js";
import pdf from "pdf-text-extract";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { dirname } from "path";

const pdfOptions = {
	exec: "/usr/local/bin/pdftotext",
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const writeFileAsync = promisify(fs.writeFile);
const unlinkFileAsync = promisify(fs.unlink);

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

/**
 * We keep the sanitizePdfString logic,
 * but be aware it strips out non-ASCII (including bullet '•').
 */
function sanitizePdfString(str) {
	if (!str) return "";
	// Replace bullet (•) with a placeholder
	let replaced = str.replace(/•/g, "BULLET_PLACEHOLDER");
	// Remove all non-ASCII characters except bullet
	replaced = replaced.replace(/[^\x00-\x7F•]/g, "");
	// Restore placeholder as an ASCII bullet marker
	replaced = replaced.replace(/BULLET_PLACEHOLDER/g, "* ");
	return replaced;
}

function ensureSpace(page, pdfDoc, yPos, threshold = 60) {
	if (yPos < threshold) {
		page = pdfDoc.addPage();
		yPos = page.getSize().height - 50;
	}
	return { page, yPos };
}

/** Social Links & Lines **/
function parseSocialLinks(lines) {
	const linkRegex = /(https?:\/\/\S+)/gi;
	let linkedin = "",
		portfolio = "",
		github = "";

	lines.forEach((line) => {
		const matches = line.match(linkRegex);
		if (!matches) return;
		matches.forEach((url) => {
			const lowerUrl = url.toLowerCase();
			if (lowerUrl.includes("linkedin.com")) linkedin = url;
			else if (lowerUrl.includes("github.com")) github = url;
			else if (
				lowerUrl.includes("portfolio") ||
				lowerUrl.includes("netlify") ||
				lowerUrl.includes("vercel") ||
				lowerUrl.includes("myportfolio.com")
			) {
				portfolio = url;
			}
		});
	});

	return { linkedin, portfolio, github };
}

function parseSocialLines(lines) {
	const socialLines = [];
	const keywords = ["linkedin", "github", "portfolio"];
	const ignoreIfContains = ["version control", "ci/cd"];

	lines.forEach((line) => {
		const lower = line.toLowerCase();
		const hasKeyword = keywords.some((kw) => lower.includes(kw));
		const hasIgnoreWord = ignoreIfContains.some((ig) => lower.includes(ig));
		if (hasKeyword && !hasIgnoreWord) {
			socialLines.push(line);
		}
	});
	return socialLines;
}

function extractUrls(line) {
	const urlRegex = /(https?:\/\/\S+)/gi;
	return line.match(urlRegex) || [];
}

function drawSocialLines(page, lines, x, yPos, options) {
	const { font, size, color, lineHeight } = options;

	lines.forEach((line) => {
		page.drawText(sanitizePdfString(line), {
			x,
			y: yPos,
			size,
			font,
			color,
		});

		// clickable links
		const urls = extractUrls(line);
		if (urls.length > 0) {
			let currentX = x;
			const words = line.split(/\s+/);
			words.forEach((word) => {
				const wordWidth = font.widthOfTextAtSize(word + " ", size);
				if (urls.includes(word)) {
					page.linkAnnotation({
						x: currentX,
						y: yPos,
						width: wordWidth,
						height: size,
						url: word,
					});
				}
				currentX += wordWidth;
			});
		}

		yPos -= lineHeight;
	});

	return yPos;
}

/** Wrapping & Bullets **/
function wrapText(
	page,
	text,
	x,
	startYPos,
	indent,
	{ font, size, maxWidth, lineHeight }
) {
	let yPos = startYPos;
	const words = text.split(/\s+/);
	let currentLine = "";

	words.forEach((word) => {
		const sanitizedWord = sanitizePdfString(word);
		const testLine = currentLine + sanitizedWord + " ";
		const textWidth = font.widthOfTextAtSize(testLine, size);

		if (textWidth > maxWidth - indent) {
			page.drawText(sanitizePdfString(currentLine.trim()), {
				x: x + indent,
				y: yPos,
				size,
				font,
			});
			yPos -= lineHeight;
			currentLine = sanitizedWord + " ";
		} else {
			currentLine = testLine;
		}
	});

	if (currentLine.trim()) {
		page.drawText(sanitizePdfString(currentLine.trim()), {
			x: x + indent,
			y: yPos,
			size,
			font,
		});
		yPos -= lineHeight;
	}

	return yPos;
}

function drawWrappedText(page, text, x, startYPos, options) {
	return wrapText(page, text, x, startYPos, 0, options);
}

function parseBullets(text) {
	return text.split(/\r?\n/).filter((line) => line.trim().match(/^[-•]\s+/));
}

function drawBulletedList(page, bulletLines, x, startYPos, options) {
	let yPos = startYPos;
	bulletLines.forEach((line) => {
		const cleanLine = line.replace(/^[-•]\s+/, "");
		page.drawText("•", {
			x,
			y: yPos,
			size: options.size,
			font: options.font,
		});
		yPos = wrapText(page, cleanLine, x + 15, yPos, 0, options);
		yPos -= 5;
	});
	return yPos;
}

/** Nested Projects **/
function parseNestedProjectBullets(text) {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	const projects = [];
	let currentProject = null;

	lines.forEach((line) => {
		if (line.startsWith("• ")) {
			if (currentProject) projects.push(currentProject);
			currentProject = {
				projectTitle: line.replace(/^•\s*/, ""),
				details: [],
			};
		} else if (line.startsWith("- ") && currentProject) {
			const detail = line.replace(/^-\s*/, "");
			currentProject.details.push(detail);
		}
	});
	if (currentProject) projects.push(currentProject);

	return projects;
}

function drawNestedProjects(page, projects, x, yPos, options, pdfDoc) {
	const { font, size, maxWidth, lineHeight, boldFont } = options;
	const detailIndent = 30;

	projects.forEach((project) => {
		({ page, yPos } = ensureSpace(page, pdfDoc, yPos, 60));
		page.drawText(sanitizePdfString(project.projectTitle), {
			x,
			y: yPos,
			size,
			font: boldFont,
		});
		yPos -= lineHeight;
		yPos -= 5;

		project.details.forEach((detail) => {
			({ page, yPos } = ensureSpace(page, pdfDoc, yPos, 60));
			page.drawText("•", {
				x: x + detailIndent - 15,
				y: yPos,
				size,
				font,
			});
			yPos = wrapText(
				page,
				sanitizePdfString(detail),
				x + detailIndent,
				yPos,
				0,
				{ font, size, maxWidth, lineHeight }
			);
			yPos -= 5;
		});

		yPos -= 10;
	});
	return yPos;
}

/** Nested Experience **/
function parseNestedExperienceBullets(text) {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	const roles = [];
	let currentRole = null;

	lines.forEach((line) => {
		if (line.startsWith("• ")) {
			if (currentRole) roles.push(currentRole);
			currentRole = {
				roleTitle: line.replace(/^•\s*/, ""),
				details: [],
			};
		} else if (line.startsWith("- ") && currentRole) {
			const detail = line.replace(/^-\s*/, "");
			currentRole.details.push(detail);
		}
	});
	if (currentRole) roles.push(currentRole);

	return roles;
}

function drawNestedExperience(page, roles, x, yPos, options, pdfDoc) {
	const { font, boldFont, size, maxWidth, lineHeight } = options;
	const detailIndent = 30;

	roles.forEach((role) => {
		// Ensure there's space for this entire role heading
		({ page, yPos } = ensureSpace(page, pdfDoc, yPos, 60));
		page.drawText(role.roleTitle, {
			x,
			y: yPos,
			size,
			font: boldFont,
		});
		yPos -= lineHeight + 5;

		// Now draw each detail bullet
		role.details.forEach((detail) => {
			page.drawText("•", {
				x: x + detailIndent - 15,
				y: yPos,
				size,
				font,
			});
			yPos = wrapText(page, detail, x + detailIndent, yPos, 0, {
				font,
				size,
				maxWidth,
				lineHeight,
			});
			yPos -= 5;

			// Optionally call ensureSpace if bullets might be long
			({ page, yPos } = ensureSpace(page, pdfDoc, yPos, 60));
		});

		yPos -= 10; // gap after each role
	});

	// Return both page and yPos so the caller can keep using them
	return { page, yPos };
}

/** Route Handler **/
router.post(
	"/tailor-resume",
	authMiddleware,
	upload.single("resume"),
	async (req, res) => {
		try {
			const userId = req.user.id;

			let {
				job_description,
				candidate_name,
				candidate_title,
				candidate_location,
				candidate_phone,
				candidate_email,
			} = req.body;

			const resumeFile = req.file;
			if (!resumeFile) {
				return res.status(400).json({ error: "No resume file uploaded." });
			}
			if (!job_description) {
				return res.status(400).json({ error: "Job description is required." });
			}

			// Step 1: Parse PDF
			let resumeText = "";
			const parsePDF = async (buffer) => {
				const tempFilePath = path.join(__dirname, "../temp_upload.pdf");
				await writeFileAsync(tempFilePath, buffer);
				return new Promise((resolve, reject) => {
					pdf(tempFilePath, pdfOptions, (err, text) => {
						unlinkFileAsync(tempFilePath).catch(console.error);
						if (err) {
							console.error("PDF Parsing Error:", err);
							reject("Failed to extract resume text.");
						} else {
							resolve(text);
						}
					});
				});
			};

			try {
				resumeText = await parsePDF(resumeFile.buffer);
			} catch (err) {
				console.error("PDF Parsing Error:", err);
				return res
					.status(500)
					.json({ error: err || "Failed to extract resume text." });
			}

			if (Array.isArray(resumeText)) {
				resumeText = resumeText.join("\n");
			}

			// If candidate details are missing, attempt to extract from resume text
			{
				const lines = resumeText
					.split(/\r?\n/)
					.filter((line) => line.trim().length > 0);
				// parse social links
				let { linkedin, portfolio, github } = parseSocialLinks(lines);

				if (!candidate_name) {
					candidate_name = lines[0]
						? lines[0].split(",")[0].trim()
						: "Candidate Name";
				}
				if (!candidate_title) {
					candidate_title = lines[1] || "Candidate Title";
				}
				if (!candidate_location || !candidate_phone || !candidate_email) {
					const contactLine = lines[2] || "";
					if (!candidate_location) {
						candidate_location = contactLine.split("|")[0].trim();
					}
					if (!candidate_phone) {
						const phoneMatch = contactLine.match(
							/(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})/
						);
						candidate_phone = phoneMatch ? phoneMatch[0] : "";
					}
					if (!candidate_email) {
						const emailMatch = contactLine.match(/\S+@\S+\.\S+/);
						candidate_email = emailMatch ? emailMatch[0] : "";
					}
				}
			}

			// Step 2: Call OpenAI
			const response = await openaiClient.post("/chat/completions", {
				model: "gpt-4-turbo",
				max_tokens: 1000,
				messages: [
					{
						role: "system",
						content: `
               You are a professional resume tailoring assistant.
                DO NOT reintroduce any name, phone number, email, or location.
                Return EXACTLY five sections in this order:
                1) ## Summary (3-5 sentences) - no personal projects
                2) ## Technical Skills (bullet points) - no personal projects
                3) ## Highlighted Projects (bullet points) - only place personal projects here
                4) ## Professional Experience (bullet points for each role)
                5) ## Education (bullet points for each education item)

                Do not provide any other sections or headings.
               	Do not include any personal identifiers.
                Do not use the phrase "the candidate."
				Do not merge or condense any roles. Each role from the user’s original resume must appear as a separate bullet starting with ‘•’

               For Technical Skills, each bullet must begin with '- ' (dash + space).
                For Highlighted Projects, use this exact structure:
                ## Highlighted Projects
                • [Project Title]
                - [Detail line 1]
                - [Detail line 2]

                (blank line)

                • [Next Project Title]
               - [Detail line 1]
                - ...

                For Professional Experience, please use this exact structure:
                ## Professional Experience
                • [Job Title / Company / Years]
                - [Bullet describing an achievement]
               - [Another bullet]

                (blank line)

                • [Next Role Title / Company / Years]
                - [Detail bullet]
                - ...

                For Education, please use this exact structure:
                ## Education
                • [School Name / Degree / Years]
               - [Detail bullet, if any]

                (blank line)

                • [Next Education Item]
                - [Detail bullet]
                - ...
              `,
					},
					{
						role: "user",
						content: `
                Here is my original resume text (excluding name/contact info):
                ---
                ${resumeText}
                ---

                Here is the job description:
                ---
                ${job_description}
                ---

                Please tailor the resume text to align with the job description,
                returning EXACTLY five sections:
                1) ## Summary (3-5 sentences)
                2) ## Technical Skills (bullet points)
                3) ## Highlighted Projects (bullet points) – even if very brief.
                4) ## Professional Experience (bullet points for each role)
                5) ## Education (bullet points for each education item)
            `,
					},
				],
			});

			let rawTailoredText = response.data.choices[0].message.content.trim();
			let tailoredText = rawTailoredText.replace(/the candidate/gi, "").trim();

			// Extract sections
			function extractSection(fullText, sectionHeader, nextSectionHeader) {
				let pattern;
				if (!nextSectionHeader) {
					// Match everything from sectionHeader to the end of the text
					pattern = new RegExp(`${sectionHeader}[\\s\\S]*$`, "i");
				} else {
					pattern = new RegExp(
						`${sectionHeader}[\\s\\S]*?(?=${nextSectionHeader}|$)`,
						"i"
					);
				}
				const match = fullText.match(pattern);
				if (!match) return "";
				return match[0].replace(sectionHeader, "").trim();
			}

			const summaryText = extractSection(
				tailoredText,
				"## Summary",
				"## Technical Skills"
			);
			const technicalSkillsText = extractSection(
				tailoredText,
				"## Technical Skills",
				"## Highlighted Projects"
			);
			const highlightedProjectsText = extractSection(
				tailoredText,
				"## Highlighted Projects",
				"## Professional Experience"
			);
			const professionalExperienceText = extractSection(
				tailoredText,
				"## Professional Experience",
				"## Education"
			);
			const educationText = extractSection(tailoredText, "## Education", "");

			// Step 3: Generate the PDF
			const pdfDoc = await PDFDocument.create();
			const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
			const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

			let page = pdfDoc.addPage();
			const { width, height } = page.getSize();

			// Name & Title
			const candidateNameFinal = candidate_name || "Candidate Name";
			const candidateTitleFinal = candidate_title || "Candidate Title";

			let yPos = height - 50;
			page.drawText(sanitizePdfString(candidateNameFinal), {
				x: 50,
				y: yPos,
				size: 24,
				font,
			});

			yPos -= 30;
			page.drawText(sanitizePdfString(candidateTitleFinal.trim()), {
				x: 50,
				y: yPos,
				size: 16,
				font,
			});

			// Contact Info
			yPos -= 30;
			const contactLine1Parts = [];
			if (candidate_location) contactLine1Parts.push(candidate_location);
			if (candidate_phone) contactLine1Parts.push(candidate_phone);
			if (candidate_email) contactLine1Parts.push(candidate_email);
			const contactLine1 = contactLine1Parts.join(" | ");

			page.drawText(sanitizePdfString(contactLine1), {
				x: 50,
				y: yPos,
				size: 12,
				font,
				color: rgb(0, 0, 0),
			});
			yPos -= 15;

			// Social lines
			const allLines = resumeText
				.split(/\r?\n/)
				.filter((l) => l.trim().length > 0);
			const socialLines = parseSocialLines(allLines);
			yPos = drawSocialLines(page, socialLines, 50, yPos, {
				font,
				size: 12,
				color: rgb(0, 0, 1),
				lineHeight: 15,
			});
			yPos -= 15;

			// SUMMARY
			({ page, yPos } = ensureSpace(page, pdfDoc, yPos, 60));
			page.drawText("SUMMARY", {
				x: 50,
				y: yPos,
				size: 14,
				font: boldFont,
			});
			yPos -= 20;
			const lineHeightVal = 14;
			const margin = 50;
			const maxTextWidth = width - margin * 2;

			yPos = drawWrappedText(page, summaryText, 50, yPos, {
				font,
				size: 12,
				maxWidth: maxTextWidth,
				lineHeight: lineHeightVal,
			});

			// TECHNICAL SKILLS
			({ page, yPos } = ensureSpace(page, pdfDoc, yPos, 60));
			yPos -= 30;
			page.drawText("TECHNICAL SKILLS", {
				x: 50,
				y: yPos,
				size: 14,
				font: boldFont,
			});
			yPos -= 20;

			const bulletLines = parseBullets(technicalSkillsText);
			yPos = drawBulletedList(page, bulletLines, 50, yPos, {
				font,
				size: 12,
				maxWidth: maxTextWidth,
				lineHeight: lineHeightVal,
			});

			// HIGHLIGHTED PROJECTS
			({ page, yPos } = ensureSpace(page, pdfDoc, yPos, 60));
			yPos -= 30;
			page.drawText("HIGHLIGHTED PROJECTS", {
				x: 50,
				y: yPos,
				size: 14,
				font: boldFont,
			});
			yPos -= 20;

			const projects = parseNestedProjectBullets(highlightedProjectsText);
			yPos = drawNestedProjects(
				page,
				projects,
				50,
				yPos,
				{
					font,
					boldFont,
					size: 12,
					maxWidth: maxTextWidth,
					lineHeight: lineHeightVal,
				},
				pdfDoc
			);

			// PROFESSIONAL EXPERIENCE
			({ page, yPos } = ensureSpace(page, pdfDoc, yPos, 60));
			yPos -= 30;
			page.drawText("PROFESSIONAL EXPERIENCE", {
				x: 50,
				y: yPos,
				size: 14,
				font: boldFont,
			});
			yPos -= 20;

			const roles = parseNestedExperienceBullets(professionalExperienceText);
			({ page, yPos } = drawNestedExperience(
				page,
				roles,
				50,
				yPos,
				{ font, boldFont, size: 12, maxWidth: maxTextWidth, lineHeight: 14 },
				pdfDoc
			));

			({ page, yPos } = ensureSpace(page, pdfDoc, yPos, 60));

			// EDUCATION
			({ page, yPos } = ensureSpace(page, pdfDoc, yPos, 60));
			yPos -= 30;
			page.drawText("EDUCATION", {
				x: 50,
				y: yPos,
				size: 14,
				font: boldFont,
			});
			yPos -= 20;

			const eduBulletLines = parseBullets(educationText);
			yPos = drawBulletedList(page, eduBulletLines, 50, yPos, {
				font,
				size: 12,
				maxWidth: maxTextWidth,
				lineHeight: lineHeightVal,
			});

			// Finalize
			const pdfBytes = await pdfDoc.save();
			res.setHeader(
				"Content-Disposition",
				"attachment; filename=tailored_resume.pdf"
			);
			res.setHeader("Content-Type", "application/pdf");
			return res.send(Buffer.from(pdfBytes));
		} catch (error) {
			console.error(
				"Error calling OpenAI:",
				error.response?.data || error.message
			);
			return res.status(500).json({ error: "Failed to connect to OpenAI" });
		}
	}
);

export default router;
