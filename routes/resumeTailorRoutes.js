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
 * If that’s causing issues, you can remove the line that strips non-ASCII.
 */
function sanitizePdfString(str) {
	if (!str) return "";
	// Replace bullet (•) with a placeholder
	let replaced = str.replace(/•/g, "BULLET_PLACEHOLDER");
	// Remove all non-ASCII characters
	replaced = replaced.replace(/[^\x00-\x7F•]/g, "");
	// Restore placeholder as an ASCII bullet marker
	replaced = replaced.replace(/BULLET_PLACEHOLDER/g, "* ");
	return replaced;
}

function parseSocialLinks(lines) {
	// This regex matches anything that starts with http(s):// and goes until whitespace
	const linkRegex = /(https?:\/\/\S+)/gi;

	let linkedin = "";
	let portfolio = "";
	let github = "";

	lines.forEach((line) => {
		// Find all URLs in the current line
		const matches = line.match(linkRegex);
		if (!matches) return;

		matches.forEach((url) => {
			const lowerUrl = url.toLowerCase();
			if (lowerUrl.includes("linkedin.com")) {
				linkedin = url;
			} else if (lowerUrl.includes("github.com")) {
				github = url;
			} else if (
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

/** NEW: parseSocialLines, extractUrls, drawSocialLines **/

function parseSocialLines(lines) {
	const socialLines = [];
	const keywords = ["linkedin", "github", "portfolio"];
	const ignoreIfContains = ["version control", "ci/cd"];

	lines.forEach((line) => {
		const lower = line.toLowerCase();

		// If it includes 'github'/'linkedin'/'portfolio'
		const hasKeyword = keywords.some((kw) => lower.includes(kw));

		// If it also includes 'version control'/'ci/cd', we skip it
		const hasIgnoreWord = ignoreIfContains.some((ig) => lower.includes(ig));

		if (hasKeyword && !hasIgnoreWord) {
			socialLines.push(line);
		}
	});

	return socialLines;
}

function extractUrls(line) {
	const urlRegex = /(https?:\/\/\S+)/gi;
	const matches = line.match(urlRegex) || [];
	return matches;
}

function drawSocialLines(page, lines, x, y, options) {
	const { font, size, color, lineHeight } = options;

	lines.forEach((line) => {
		// Draw the entire social line in the chosen color
		page.drawText(sanitizePdfString(line), {
			x,
			y,
			size,
			font,
			color,
		});

		// If there are any URLs, create clickable link annotations
		const urls = extractUrls(line);
		if (urls.length > 0) {
			let currentX = x;
			const words = line.split(/\s+/);

			// We'll do a rough measurement to place link annotations over each word
			words.forEach((word) => {
				const wordWidth = font.widthOfTextAtSize(word + " ", size);
				if (urls.includes(word)) {
					// Place an annotation over this word
					page.linkAnnotation({
						x: currentX,
						y,
						width: wordWidth,
						height: size,
						url: word,
					});
				}
				currentX += wordWidth;
			});
		}

		y -= lineHeight;
	});

	return y;
}

/** END NEW FUNCTIONS **/

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

			// Social link variables (from parseSocialLinks)
			let linkedin = "",
				portfolio = "",
				github = "";

			// If candidate details are missing, attempt to extract from resume text
			{
				const lines = resumeText
					.split(/\r?\n/)
					.filter((line) => line.trim().length > 0);

				({ linkedin, portfolio, github } = parseSocialLinks(lines));

				// Attempt to extract candidate_name, candidate_title, etc.
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
                Return EXACTLY three sections in this order:
                1) ## Summary (3-5 sentences) - no personal projects
                2) ## Technical Skills (bullet points) - no personal projects
                3) ## Highlighted Projects (bullet points) - only place personal projects here

                Do not provide any other sections or headings.
                Do not include any personal identifiers.
                Do not use the phrase "the candidate."

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
                returning EXACTLY three sections:
                1) ## Summary (3-5 sentences)
                2) ## Technical Skills (bullet points)
                3) ## Highlighted Projects (bullet points) – even if very brief.
              `,
					},
				],
			});

			let rawTailoredText = response.data.choices[0].message.content.trim();
			let tailoredText = rawTailoredText.replace(/the candidate/gi, "").trim();

			// We have our final text, let's extract the three sections
			function extractSection(fullText, sectionHeader, nextSectionHeader) {
				const pattern = new RegExp(
					`${sectionHeader}[\\s\\S]*?(?=${nextSectionHeader}|$)`,
					"i"
				);
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
				"$$$"
			);

			// Basic text wrapping
			function wrapText(
				page,
				text,
				x,
				startY,
				indent,
				{ font, size, maxWidth, lineHeight }
			) {
				const words = text.split(/\s+/);
				let currentLine = "";
				let y = startY;

				for (const word of words) {
					const sanitizedWord = sanitizePdfString(word);
					const testLine = currentLine + sanitizedWord + " ";
					const textWidth = font.widthOfTextAtSize(testLine, size);

					if (textWidth > maxWidth - indent) {
						page.drawText(sanitizePdfString(currentLine.trim()), {
							x: x + indent,
							y,
							size,
							font,
						});
						y -= lineHeight;
						currentLine = sanitizedWord + " ";
					} else {
						currentLine = testLine;
					}
				}

				if (currentLine.trim()) {
					page.drawText(sanitizePdfString(currentLine.trim()), {
						x: x + indent,
						y,
						size,
						font,
					});
					y -= lineHeight;
				}

				return y;
			}

			function drawWrappedText(page, text, x, startY, options) {
				// simple wrapper
				return wrapText(page, text, x, startY, 0, options);
			}

			// Functions to parse bullet lines
			function parseBullets(text) {
				return text
					.split(/\r?\n/)
					.filter((line) => line.trim().match(/^[-•]\s+/));
			}

			function drawBulletedList(page, bulletLines, x, startY, options) {
				let y = startY;
				bulletLines.forEach((line) => {
					const cleanLine = line.replace(/^[-•]\s+/, "");
					page.drawText("•", {
						x,
						y,
						size: options.size,
						font: options.font,
					});
					y = wrapText(page, cleanLine, x + 15, y, 0, options);
					y -= 5;
				});
				return y;
			}

			// Nested Projects
			function parseNestedProjectBullets(text) {
				const lines = text
					.split(/\r?\n/)
					.map((l) => l.trim())
					.filter(Boolean);
				const projects = [];
				let currentProject = null;

				for (const line of lines) {
					if (line.startsWith("• ")) {
						if (currentProject) {
							projects.push(currentProject);
						}
						currentProject = {
							projectTitle: line.replace(/^•\s*/, ""),
							details: [],
						};
					} else if (line.startsWith("- ") && currentProject) {
						const detail = line.replace(/^-\s*/, "");
						currentProject.details.push(detail);
					}
				}
				if (currentProject) {
					projects.push(currentProject);
				}
				return projects;
			}

			function drawNestedProjects(page, projects, x, y, options) {
				const { font, size, maxWidth, lineHeight } = options;
				const detailIndent = 30;

				for (const project of projects) {
					page.drawText(sanitizePdfString(project.projectTitle), {
						x,
						y,
						size,
						font: options.boldFont, // use bold for project title
					});

					y -= lineHeight;
					y -= 5;

					for (const detail of project.details) {
						page.drawText("•", {
							x: x + detailIndent - 15,
							y,
							size,
							font,
						});
						y = wrapText(
							page,
							sanitizePdfString(detail),
							x + detailIndent,
							y,
							0,
							{
								font,
								size,
								maxWidth,
								lineHeight,
							}
						);
						y -= 5;
					}

					y -= 10;
				}
				return y;
			}

			// Step 3: Generate the PDF
			const pdfDoc = await PDFDocument.create();
			const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
			const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

			const page = pdfDoc.addPage();
			const { width, height } = page.getSize();

			// Name & Title
			const candidateNameFinal = candidate_name || "Candidate Name";
			const candidateTitleFinal = candidate_title || "Candidate Title";

			page.drawText(sanitizePdfString(candidateNameFinal), {
				x: 50,
				y: height - 50,
				size: 24,
				font,
			});

			page.drawText(sanitizePdfString(candidateTitleFinal.trim()), {
				x: 50,
				y: height - 80,
				size: 16,
				font,
			});

			// Contact Info
			let yPos = height - 110;

			// -- LINE 1: location, phone, email in black
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

			// -- LINE 2: Pull any lines referencing LinkedIn/GitHub/Portfolio from the resume
			const allLines = resumeText
				.split(/\r?\n/)
				.filter((line) => line.trim().length > 0);
			const socialLines = parseSocialLines(allLines);

			// Draw them in blue, making any http(s):// portion clickable
			yPos = drawSocialLines(page, socialLines, 50, yPos, {
				font,
				size: 12,
				color: rgb(0, 0, 1),
				lineHeight: 15,
			});
			yPos -= 15;

			// SUMMARY
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
			yPos -= 30;
			page.drawText("HIGHLIGHTED PROJECTS", {
				x: 50,
				y: yPos,
				size: 14,
				font: boldFont,
			});
			yPos -= 20;

			const projects = parseNestedProjectBullets(highlightedProjectsText);
			yPos = drawNestedProjects(page, projects, 50, yPos, {
				font,
				boldFont,
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
