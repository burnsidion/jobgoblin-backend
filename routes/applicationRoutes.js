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

router.get("/", authMiddleware, async (req, res) => {
	const userId = req.user.id;

	const { data, error } = await getSupabaseClient(
		process.env.SUPABASE_SERVICE_ROLE_KEY
	)
		.from("applications")
		.select("*")
		.eq("user_id", userId);

	if (error) return res.status(400).json({ error: error.message });

	res.status(200).json({ resumes: data });
});

router.post(
	"/tailor-resume",
	authMiddleware,
	upload.single("resume"),
	async (req, res) => {
		try {
			const userId = req.user.id;
			const { job_description } = req.body;
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

			// Step 2: Call OpenAI (Short Summary Only)
			const response = await openaiClient.post("/chat/completions", {
				model: "gpt-4-turbo",
				max_tokens: 150,
				messages: [
					{
						role: "system",
						content: `
						  You are a professional resume tailoring assistant.
						  The user has removed their name and contact info from the resume.
						  DO NOT reintroduce any name, phone number, email, or location.
						  Adjust the provided resume text to align with the given job description.

						  Return EXACTLY 3 sentences (no more, no less) summarizing the individual's
						  relevant skills and experience for the role, without using the phrase "the candidate."
						  Do not provide any other sections or headings.
						  Do not include any personal identifiers.
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
				  but return EXACTLY 3 sentences summarizing my relevant skills and experience.
				`,
					},
				],
			});

			function limitSentences(text, maxSentences) {
				const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
				return sentences.slice(0, maxSentences).join(" ").trim();
			}

			let rawTailoredText = response.data.choices[0].message.content.trim();
			let tailoredText = rawTailoredText.replace(/[^\x00-\x7F]/g, "");
			tailoredText = tailoredText.replace(/the candidate/gi, "").trim();

			// Step 3: Generate a PDF (Header + Contact + Summary)
			const pdfDoc = await PDFDocument.create();
			const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
			const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

			const page = pdfDoc.addPage();
			const { width, height } = page.getSize();

			// Header Section
			const candidateName = "Ian Burnside";
			const candidateTitle = "FRONTEND DEVELOPER | VUE.JS SPECIALIST";

			page.drawText(candidateName, {
				x: 50,
				y: height - 50,
				size: 24,
				font,
			});

			page.drawText(candidateTitle, {
				x: 50,
				y: height - 80,
				size: 16,
				font,
			});

			// Contact Info
			let yPos = height - 110;
			const contactFontSize = 12;
			const contacts = [
				{ label: "Boulder, CO" },
				{ label: "561-715-6031" },
				{ label: "ian.burnside89@gmail.com" },
			];
			for (const contact of contacts) {
				page.drawText(contact.label, {
					x: 50,
					y: yPos,
					size: contactFontSize,
					font,
				});
				yPos -= 15;
			}

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

			function drawWrappedText(
				page,
				text,
				x,
				y,
				{ font, size, maxWidth, lineHeight }
			) {
				const words = text.split(/\s+/);
				let currentLine = "";

				for (const word of words) {
					const testLine = currentLine + word + " ";
					const textWidth = font.widthOfTextAtSize(testLine, size);
					if (textWidth > maxWidth) {
						page.drawText(currentLine.trim(), { x, y, size, font });
						y -= lineHeight;
						currentLine = word + " ";
					} else {
						currentLine = testLine;
					}
				}

				// leftover text
				if (currentLine.trim()) {
					page.drawText(currentLine.trim(), { x, y, size, font });
					y -= lineHeight;
				}

				return y;
			}

			yPos = drawWrappedText(page, tailoredText, 50, yPos, {
				font,
				size: 12,
				maxWidth: maxTextWidth,
				lineHeight,
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

router.post("/", authMiddleware, async (req, res) => {
	try {
		const userId = req.user.id;

		const {
			company_name,
			job_title,
			job_link,
			job_description,
			date_applied,
			status,
			resume_used,
		} = req.body;

		const application = {
			user_id: userId,
			company_name,
			job_title,
			job_link,
			job_description,
			date_applied,
			status,
			resume_used,
		};

		const { data, error } = await getSupabaseClient(
			process.env.SUPABASE_SERVICE_ROLE_KEY
		)
			.from("applications")
			.insert([application]);

		if (error) {
			return res.status(500).json({ error: error.message });
		}

		res.status(201).json({ message: "Application created successfully", data });
	} catch (err) {
		console.error("error creating application:", err);
		res.status(500).json({ error: "Internal service error" });
	}
});

export default router;
