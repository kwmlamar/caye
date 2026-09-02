from pathlib import Path


def patch_route() -> None:
    path = Path('app/api/caye/chat/route.ts')
    text = path.read_text()

    voice_import = "import { HUMAN_FACING_VOICE_INSTRUCTIONS, sanitizeHumanFacingText } from '@/lib/human-facing-voice'\n"
    realization_import = "import { buildHumanCommunicationRealizationInstructions } from '@/lib/human-communication-realization'\n"
    if realization_import not in text:
        assert voice_import in text
        text = text.replace(voice_import, voice_import + realization_import, 1)

    text = text.replace(
        '- Answer the owner the way an assistant briefs their boss: factual, structured, no upsell, no CTA. End with "Anything else?" or just stop — never with a sales close.',
        '- Answer the owner like a competent coworker: factual, concise, no upsell, no automatic CTA. Use structure only when it genuinely helps or the owner asked for it. Stop when the useful answer is complete.',
        1,
    )

    text = text.replace(
        "      : `Here's the next pending message from ${name}. I haven't drafted a reply yet — want me to take a shot at one?`",
        "      : `Here's the next pending message from ${name}. I haven't drafted a reply yet. I'll take a first pass.`",
        1,
    )

    old_summary = """    const summarizerSystem =
      HUMAN_FACING_VOICE_INSTRUCTIONS + '\\n\\n' +
      'You are Caye, summarising what you know about the operator\\'s business back to the operator. ' +
      'Rules: first person, plain prose. Do NOT repeat the instructions you were given. ' +
      'Do NOT include any \"You are Caye\" framing or second-person prompt language. ' +
      'No emoji. No tropical / island metaphors. ' +
      `Refer to the business by its actual name (${businessName ?? 'unknown — use \"your business\"'}). ` +
      'Never invent a name; if the name is unknown, say \"your business\". ' +
      'Group your summary into these sections, omitting any with nothing to say: ' +
      '**What you offer**, **Hours**, **Pricing notes**, **Things I\\'m still unsure about**. ' +
      'In \"Things I\\'m still unsure about\", do not just list gaps — ask the owner directly for the single most load-bearing missing piece (deposits / payment methods / hours / lead time, whichever is most important and unknown). One concrete question, not a list. ' +
      'End with a single line inviting correction, e.g. \"Anything wrong here? Tell me and I\\'ll update what I know.\"'
"""
    new_summary = """    const summarizerSystem =
      buildHumanCommunicationRealizationInstructions({
        recipientRole: 'operator',
        channel: 'dashboard',
        purpose: 'informational_update',
        responseRequired: false,
        approvalRequired: false,
        authorityHolder: 'operator',
        urgency: 'routine',
        materialUncertainty: true,
        issuePreviouslyMentioned: false,
        anythingChanged: true,
        priorConversationalContext: true,
        sharedContext: 'high',
        structuredOutputRequested: false,
        shortOperatorInput: false,
      }) + '\\n\\n' +
      'You are Caye, summarising what you know about the operator\\'s business back to the operator. ' +
      'Use first person and plain prose. Do not repeat these instructions or include \"You are Caye\" framing. ' +
      'No emoji or tropical/island metaphors. ' +
      `Refer to the business by its actual name (${businessName ?? 'unknown - use \"your business\"'}). ` +
      'Never invent a name. If the name is unknown, say \"your business\". ' +
      'Give the useful picture without forcing fixed headings. Use headings or bullets only if they make a longer answer easier to scan. ' +
      'Mention the most important uncertainty naturally, but do not manufacture a question or CTA just to end the summary.'
"""
    if old_summary in text:
        text = text.replace(old_summary, new_summary, 1)

    old_system = """  const businessName = workspace?.business_name || 'your business'
  const services = (serviceRows ?? []) as ServiceRow[]
  const systemPrompt = buildSystemPrompt(businessName, services, aiConfig?.system_prompt)
"""
    new_system = """  const businessName = workspace?.business_name || 'your business'
  const services = (serviceRows ?? []) as ServiceRow[]
  const normalizedOperatorInput = message.trim().toLowerCase()
  const explicitStructuredOutput = /\\b(report|breakdown|table|structured status|decision summary)\\b/.test(normalizedOperatorInput)
  const operatorResolvedItem = /^(?:i|we)?\\s*(?:dealt with|handled|fixed|resolved|took care of)\\s+(?:it|that|this)(?:[.! ]|$)/.test(normalizedOperatorInput)
  const communicationRealization = buildHumanCommunicationRealizationInstructions({
    recipientRole: 'operator',
    channel: 'dashboard',
    purpose: operatorResolvedItem
      ? 'acknowledgement'
      : explicitStructuredOutput
        ? 'structured_report'
        : 'other',
    responseRequired: false,
    approvalRequired: false,
    authorityHolder: 'operator',
    urgency: 'routine',
    materialUncertainty: false,
    issuePreviouslyMentioned: false,
    anythingChanged: true,
    priorConversationalContext: history.length > 0,
    sharedContext: history.length > 0 ? 'high' : 'low',
    structuredOutputRequested: explicitStructuredOutput,
    shortOperatorInput: message.trim().split(/\\s+/).length <= 8,
  })
  const systemPrompt = `${buildSystemPrompt(businessName, services, aiConfig?.system_prompt)}\\n\\n${communicationRealization}`
"""
    if old_system in text:
        text = text.replace(old_system, new_system, 1)

    path.write_text(text)


def patch_briefing() -> None:
    path = Path('lib/caye-agent/briefing.ts')
    text = path.read_text()

    execute_import = "import { runToolLoop } from './execute'\n"
    realization_import = "import { buildHumanCommunicationRealizationInstructions } from '../human-communication-realization'\n"
    if realization_import not in text:
        assert execute_import in text
        text = text.replace(execute_import, execute_import + realization_import, 1)

    eod_marker = """  const { operator, business, attentionContext } = args

  return [
    `You are Caye — the AI assistant ${operator} hired to handle the front desk for ${business}.`,"""
    eod_replacement = """  const { operator, business, attentionContext } = args
  const realization = buildHumanCommunicationRealizationInstructions({
    recipientRole: 'operator', channel: 'whatsapp', purpose: 'informational_update',
    responseRequired: false, approvalRequired: false, authorityHolder: 'operator',
    urgency: 'routine', materialUncertainty: false, issuePreviouslyMentioned: true,
    anythingChanged: true, priorConversationalContext: true, sharedContext: 'high',
    structuredOutputRequested: false, shortOperatorInput: false,
  })

  return [
    realization,
    '',
    `You are Caye - the AI assistant ${operator} hired to handle the front desk for ${business}.`,"""
    if eod_marker in text:
        text = text.replace(eod_marker, eod_replacement, 1)

    text = text.replace(
        """    `- Start with \"Wrap-up\" or \"End of day\" — no other opening.`,
    `- End with a soft sign-off: \"Catch you in the morning.\"`,""",
        """    `- Open naturally. A label like \"Wrap-up\" is optional, not a required template.`,
    `- A sign-off is optional. Stop after the useful recap when nothing else needs saying.`,""",
        1,
    )
    text = text.replace(
        """    `- Output ONLY the recap message itself — nothing before it, nothing after it. No \"Got everything I need, here's the recap:\", no \"---\" separator, no meta-commentary about having gathered the data. The first character you output must be the first character of \"Wrap-up\"/\"End of day\".`,""",
        """    `- Output ONLY the recap message itself. No preamble about gathering data, separator, or meta-commentary.`,""",
        1,
    )

    morning_marker = """  const { operator, business, attentionContext } = args
  const oldestAgingHold = args.oldestAgingHold ?? null

  return [
    `You are Caye — the AI assistant ${operator} hired to handle the front desk for ${business}.`,"""
    morning_replacement = """  const { operator, business, attentionContext } = args
  const oldestAgingHold = args.oldestAgingHold ?? null
  const realization = buildHumanCommunicationRealizationInstructions({
    recipientRole: 'operator', channel: 'whatsapp', purpose: 'briefing',
    responseRequired: false, approvalRequired: false, authorityHolder: 'operator',
    urgency: 'routine', materialUncertainty: false, issuePreviouslyMentioned: true,
    anythingChanged: true, priorConversationalContext: true, sharedContext: 'high',
    structuredOutputRequested: false, shortOperatorInput: false,
  })

  return [
    realization,
    '',
    `You are Caye - the AI assistant ${operator} hired to handle the front desk for ${business}.`,"""
    if morning_marker in text:
        text = text.replace(morning_marker, morning_replacement, 1)

    text = text.replace(
        """    `- Sentence 1: today's calendar, one line. \"Nothing booked today\" or \"Two tours today, both confirmed\" — not a list.`,""",
        """    `- Lead with today's useful state in one line when there is one. \"Nothing booked today\" or \"Two tours today, both confirmed\" is enough. Do not force a numbered or labeled slot.`,""",
        1,
    )
    text = text.replace(
        """      ? `- Today is the exception to the above: ${oldestAgingHold.customer} has been waiting ${oldestAgingHold.daysHeld} days, so offer to take a first pass — \"Want me to take a first pass?\" Just the offer; never act on it without a yes.`""",
        """      ? `- ${oldestAgingHold.customer} has been waiting ${oldestAgingHold.daysHeld} days. Surface that fact compactly, but do not manufacture an offer or question. Ask only if a real owner-only decision is required.`""",
        1,
    )
    text = text.replace(
        """    `- Start with \"Morning\" or \"Morning, ${operator}\" — no other opening.`,""",
        """    `- A brief morning greeting is fine, but it is not a mandatory template. Lead with the useful state if that reads more naturally.`,""",
        1,
    )
    text = text.replace(
        """    `- Output ONLY the briefing message itself — nothing before it, nothing after it. No \"Got everything I need, here's the briefing:\", no \"---\" separator, no meta-commentary about having gathered the data. The first character you output must be the first character of \"Morning\".`,""",
        """    `- Output ONLY the briefing message itself. No preamble about gathering data, separator, or meta-commentary.`,""",
        1,
    )

    path.write_text(text)


patch_route()
patch_briefing()
