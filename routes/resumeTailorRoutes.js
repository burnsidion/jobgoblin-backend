import {
	PDFDocument,
	StandardFonts,
	rgb,
	AnnotationFlags,
	PDFName,
	PDFDict,
} from "pdf-lib";
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

router.post(
	"/tailor-resume",
	authMiddleware,
	upload.single("resume"),
	async (req, res) => {
		try {
			const userId = req.user.id;

			// Convert to let so we can update them
			let {
				job_description,
				candidate_name,
				candidate_title,
				candidate_location,
				candidate_phone,
				candidate_email,
			} = req.body;

			const resumeFile = req.file;

			// Validate input
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
				// Split into non-empty lines
				const lines = resumeText
					.split(/\r?\n/)
					.filter((line) => line.trim().length > 0);

				if (!candidate_name) {
					candidate_name = lines[0]
						? lines[0].split(",")[0].trim()
						: "Candidate Name";
				}
				if (!candidate_title) {
					candidate_title = lines[1] || "Candidate Title";
				}
				// If any of location, phone, or email is missing, parse from the 3rd line
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

			// Step 2: Call OpenAI (Short Summary Only)
			const response = await openaiClient.post("/chat/completions", {
				model: "gpt-4-turbo",
				max_tokens: 250,
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

			function limitSentences(text, maxSentences) {
				const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
				return sentences.slice(0, maxSentences).join(" ").trim();
			}

			function extractSection(fullText, sectionHeader, nextSectionHeader) {
				// This captures text from sectionHeader up until the nextSectionHeader or the end of text.
				const pattern = new RegExp(
					`${sectionHeader}[\\s\\S]*?(?=${nextSectionHeader}|$)`,
					"i"
				);
				const match = fullText.match(pattern);
				if (!match) return "";
				// Remove the heading line itself from the extracted text
				return match[0].replace(sectionHeader, "").trim();
			}

			let rawTailoredText = response.data.choices[0].message.content.trim();
			let tailoredText = rawTailoredText.replace(/[^\x00-\x7F]/g, "");
			tailoredText = tailoredText.replace(/the candidate/gi, "").trim();
            tailoredText = tailoredText.replace(/\*\*/g, "");

			const summaryText = extractSection(
				tailoredText,
				"## Summary",
				"## Technical Skills"
			);
			const technicalSkillsText = extractSection(
				tailoredText,
				"## Technical Skills",
				"$$$"
			);

			const highlightedProjectsText = extractSection(
				tailoredText,
				"## Highlighted Projects",
				"$$$"
			);

			function parseBullets(text) {
				// Splits on lines that start with dash or bullet
				// e.g. "- " or "• "
				return text
					.split(/\r?\n/)
					.filter((line) => line.trim().match(/^[-•]\s+/));
			}

			function drawBulletedList(page, bullets, x, y, options) {
				const { font, size, maxWidth, lineHeight } = options;
				const bulletIndent = 15; // How far from the bullet to the text

				for (const bullet of bullets) {
					// Remove the leading dash or bullet symbol
					const lineText = bullet.replace(/^[-•]\s+/, "");

					// Draw the bullet symbol on the current line
					page.drawText("•", {
						x,
						y,
						size,
						font,
					});

					// Wrap the text for this bullet
					y = wrapText(page, lineText, x, y, bulletIndent, {
						font,
						size,
						maxWidth,
						lineHeight,
					});

					// Add a small gap after each bullet
					y -= 5;
				}

				return y;
			}
			function drawWrappedText(page, text, x, y, options) {
				return wrapText(page, sanitizePdfString(text), x, y, 0, options);
			}

			/**
			 * Helper function to wrap text to multiple lines within `maxWidth`.
			 * Indents each line by `indent` so it aligns nicely under the bullet.
			 */
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
					// Sanitize each word before adding it to the line
					const sanitizedWord = sanitizePdfString(word);
					const testLine = currentLine + sanitizedWord + " ";
					const textWidth = font.widthOfTextAtSize(testLine, size);
					if (textWidth > maxWidth - indent) {
						// Draw the current line, sanitizing it
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

				// Draw any leftover text
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

			function sanitizePdfString(str) {
				if (!str) return "";
				return str.replace(/[^\x00-\x7F]/g, "");
			}

			// Step 3: Generate a PDF (Header + Contact + Summary)
			const pdfDoc = await PDFDocument.create();
			const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
			const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

			const page = pdfDoc.addPage();
			const { width, height } = page.getSize();

			// Ensure both are left-aligned at x=50
			const candidateName = candidate_name || "Candidate Name";
			const candidateTitle = candidate_title || "Candidate Title";

			page.drawText(sanitizePdfString(candidateName), {
				x: 50,
				y: height - 50,
				size: 24,
				font,
			});

			page.drawText(sanitizePdfString(candidateTitle.trim()), {
				x: 50,
				y: height - 80,
				size: 16,
				font,
			});

			// Contact Info
			let yPos = height - 110;
			const contactFontSize = 12;
			let contacts = [];
			if (candidate_location) contacts.push({ label: candidate_location });
			if (candidate_phone) contacts.push({ label: candidate_phone });
			if (candidate_email) contacts.push({ label: candidate_email });

			contacts.forEach((contact) => {
				page.drawText(sanitizePdfString(contact.label), {
					x: 50,
					y: yPos,
					size: contactFontSize,
					font,
				});
				yPos -= 15;
			});

			// Summary Heading
			yPos -= 30;
			page.drawText("SUMMARY", {
				x: 50,
				y: yPos,
				size: 14,
				font: boldFont,
			});

			// Simple line wrapping for summary
			yPos -= 20;
			const lineHeight = 14;
			const margin = 50;
			const maxTextWidth = width - margin * 2;

			yPos = drawWrappedText(page, summaryText, 50, yPos, {
				font,
				size: 12,
				maxWidth: maxTextWidth,
				lineHeight,
			});

			yPos -= 30;
			page.drawText("TECHNICAL SKILLS", {
				x: 50,
				y: yPos,
				size: 14,
				font: boldFont,
			});
			yPos -= 20;

			// Parse the bullet lines
			const bulletLines = parseBullets(technicalSkillsText);
			// Draw them
			yPos = drawBulletedList(page, bulletLines, 50, yPos, {
				font,
				size: 12,
				maxWidth: maxTextWidth,
				lineHeight: 14,
			});

			yPos -= 30;
			page.drawText("HIGHLIGHTED PROJECTS", {
				x: 50,
				y: yPos,
				size: 14,
				font: boldFont,
			});
			yPos -= 20;

			const projectsBulletLines = parseBullets(highlightedProjectsText);

			yPos = drawBulletedList(page, projectsBulletLines, 50, yPos, {
				font,
				size: 12,
				maxWidth: maxTextWidth,
				lineHeight: 14,
			});

			// Finalize PDF
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
