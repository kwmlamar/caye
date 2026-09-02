from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f'missing expected source block: {label}')
    return text.replace(old, new, 1)


def patch_route() -> None:
    path = Path('app/api/caye/chat/route.ts')
    text = path.read_text()
    text = replace_once(
        text,
        "import { buildHumanCommunicationRealizationInstructions } from '@/lib/human-communication-realization'",
        "import { buildCommunicationRealizationInstructions } from '@/lib/communication-realization'",
        'route realization import',
    )
    text = replace_once(
        text,
        """      buildHumanCommunicationRealizationInstructions({
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
      }) + '\\n\\n' +""",
        """      buildCommunicationRealizationInstructions({
        recipientRole: 'operator',
        channel: 'dashboard',
        purpose: 'informational_update',
        responseRequired: false,
        decisionRequired: false,
        materialUncertainty: true,
        priorTurn: 'what do you know about my business',
      }) + '\\n\\n' +""",
        'business summarizer realization',
    )
    text = replace_once(
        text,
        """  const communicationRealization = buildHumanCommunicationRealizationInstructions({
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
  })""",
        """  const communicationRealization = buildCommunicationRealizationInstructions({
    recipientRole: 'operator',
    channel: 'dashboard',
    purpose: operatorResolvedItem
      ? 'acknowledgement'
      : explicitStructuredOutput
        ? 'structured_report'
        : 'informational_update',
    responseRequired: false,
    decisionRequired: false,
    priorTurn: message,
    authoritativeOperatorCorrection: operatorResolvedItem,
    explicitStructuredReport: explicitStructuredOutput,
  })""",
        'operator chat realization',
    )
    text = text.replace(
        "parts.push(`(Summarizer failed — showing raw stored content. Error: ${summarizerError ?? 'unknown'}. Anything wrong here? Tell me and I'll update what I know.)`)",
        "parts.push(`(Summarizer failed - showing raw stored content. Error: ${summarizerError ?? 'unknown'}.)`)",
        1,
    )
    path.write_text(text)


def patch_briefing() -> None:
    path = Path('lib/caye-agent/briefing.ts')
    text = path.read_text()
    text = replace_once(
        text,
        "import { buildHumanCommunicationRealizationInstructions } from '../human-communication-realization'",
        "import { buildCommunicationRealizationInstructions } from '../communication-realization'",
        'briefing realization import',
    )
    text = replace_once(
        text,
        """  const realization = buildHumanCommunicationRealizationInstructions({
    recipientRole: 'operator', channel: 'whatsapp', purpose: 'informational_update',
    responseRequired: false, approvalRequired: false, authorityHolder: 'operator',
    urgency: 'routine', materialUncertainty: false, issuePreviouslyMentioned: true,
    anythingChanged: true, priorConversationalContext: true, sharedContext: 'high',
    structuredOutputRequested: false, shortOperatorInput: false,
  })""",
        """  const realization = buildCommunicationRealizationInstructions({
    recipientRole: 'operator',
    channel: 'proactive',
    purpose: 'informational_update',
    responseRequired: false,
    decisionRequired: false,
    previouslyMentioned: true,
    changedSinceLastMention: true,
  })""",
        'eod realization',
    )
    text = replace_once(
        text,
        """  const realization = buildHumanCommunicationRealizationInstructions({
    recipientRole: 'operator', channel: 'whatsapp', purpose: 'briefing',
    responseRequired: false, approvalRequired: false, authorityHolder: 'operator',
    urgency: 'routine', materialUncertainty: false, issuePreviouslyMentioned: true,
    anythingChanged: true, priorConversationalContext: true, sharedContext: 'high',
    structuredOutputRequested: false, shortOperatorInput: false,
  })""",
        """  const realization = buildCommunicationRealizationInstructions({
    recipientRole: 'operator',
    channel: 'proactive',
    purpose: 'informational_update',
    responseRequired: false,
    decisionRequired: false,
    previouslyMentioned: true,
    changedSinceLastMention: true,
  })""",
        'morning realization',
    )
    path.write_text(text)


patch_route()
patch_briefing()
