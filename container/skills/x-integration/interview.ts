// container/skills/x-integration/interview.ts

export interface InterviewQuestion {
  id: string;
  category: string;
  question: string;
  followUp?: string;
  examples?: string[];
}

export const INTERVIEW_QUESTIONS: InterviewQuestion[] = [
  // Core Identity
  {
    id: 'archetype',
    category: 'Core Identity',
    question: 'What brand archetype best describes you? Are you the Expert sharing deep knowledge, the Friend having casual conversations, the Provocateur challenging ideas, the Educator breaking down complex topics, or the Entertainer keeping things fun?',
    followUp: 'Can you give an example of a tweet that captures this vibe?',
  },
  {
    id: 'positioning',
    category: 'Core Identity',
    question: 'Complete this sentence: "I help [who] achieve [what] through [how]." Who is your audience, what do you help them with, and how?',
  },
  {
    id: 'adjectives',
    category: 'Core Identity',
    question: 'Pick three adjectives that describe your ideal voice on X. For reference, think along these scales: funny↔serious, formal↔casual, respectful↔irreverent, enthusiastic↔matter-of-fact.',
    examples: ['Witty, casual, enthusiastic', 'Authoritative, respectful, matter-of-fact', 'Irreverent, funny, casual'],
  },
  // Voice & Tone
  {
    id: 'tone_variation',
    category: 'Voice & Tone',
    question: 'How should your tone shift in different situations? Think about: celebrating wins, responding to criticism, sharing knowledge, and casual daily engagement.',
  },
  {
    id: 'language',
    category: 'Voice & Tone',
    question: 'What are your language preferences? Consider: emoji usage (never/sparingly/frequently), hashtag style, sentence length, and vocabulary level (technical jargon OK or keep it accessible?).',
  },
  // Content Strategy
  {
    id: 'pillars',
    category: 'Content Strategy',
    question: 'What are your 3-5 content pillars — the main topics you want to post about? Roughly what percentage of your content should each pillar get?',
    examples: ['40% industry insights, 25% behind-the-scenes, 20% engagement, 15% promotion'],
  },
  {
    id: 'formats',
    category: 'Content Strategy',
    question: 'What content formats do you prefer? Single tweets vs threads? Text-only vs media? Do you use polls? How do you feel about quote tweets?',
  },
  // Engagement Philosophy
  {
    id: 'always_engage',
    category: 'Engagement Philosophy',
    question: 'What types of accounts, topics, or content should you ALWAYS engage with? Think about accounts you admire, topics in your niche, or types of conversations you want to be part of.',
  },
  {
    id: 'never_engage',
    category: 'Engagement Philosophy',
    question: 'What are your hard boundaries? Topics, accounts, or types of content you should NEVER engage with? (Politics, competitors, controversial topics, specific accounts, etc.)',
  },
  {
    id: 'engagement_style',
    category: 'Engagement Philosophy',
    question: 'What\'s your preferred engagement style? How often do you like vs reply vs repost? Do you prefer one-off replies or longer conversations? How do you approach quote tweets?',
  },
  // Goals
  {
    id: 'objective',
    category: 'Goals',
    question: 'What\'s your primary objective on X? Brand awareness, thought leadership, community building, lead generation, customer support, or something else?',
  },
  {
    id: 'audience',
    category: 'Goals',
    question: 'Who is your target audience? Describe their demographics, interests, professional level, and what they care about.',
  },
];

export function buildInterviewSystemPrompt(existingPersona?: string): string {
  const questionList = INTERVIEW_QUESTIONS.map(
    (q, i) => `${i + 1}. [${q.category}] ${q.question}`,
  ).join('\n');

  const existingContext = existingPersona
    ? `\n\nThe user already has a persona draft. Use it as a starting point and ask questions to refine it:\n\n<existing-persona>\n${existingPersona}\n</existing-persona>`
    : '';

  return `You are a social media brand strategist conducting a persona interview. Your job is to ask questions one at a time, listen carefully to the answers, and build a comprehensive persona document.

## Interview Framework

These are the questions you need to cover. Ask them one at a time, in a natural conversational order. You don't need to ask every question verbatim — adapt based on the user's answers. If they've already covered something, skip it. If something needs clarification, ask a follow-up.

${questionList}
${existingContext}

## Rules

1. Ask ONE question at a time. Wait for the answer before continuing.
2. Be conversational and encouraging. Acknowledge good answers.
3. If an answer is vague, ask a specific follow-up to get concrete details.
4. After all questions are answered (or the user says they're done), generate the complete persona markdown.
5. Save the persona to x-persona.md in the current working directory using the file writing tools.
6. The persona should follow this structure:

\`\`\`markdown
# X Persona

## Voice
- **Archetype:** [archetype]
- **Adjectives:** [three adjectives]
- **Positioning:** [one-sentence positioning]

## Tone Guide
| Situation | Tone | Example |
|-----------|------|---------|
| Celebrating | ... | ... |
| Criticism | ... | ... |
| Knowledge sharing | ... | ... |
| Casual | ... | ... |

## Language Rules
- Emoji: [usage level]
- Hashtags: [style]
- Vocabulary: [level]
- Sentence style: [preferences]

## Content Pillars
1. [Pillar] — [%] — [description]
2. [Pillar] — [%] — [description]
3. [Pillar] — [%] — [description]

## Engagement Rules

### Always Engage
- [criteria]

### Never Engage
- [criteria]

### Engagement Style
- Like ratio: [description]
- Reply depth: [description]
- Quote tweet approach: [description]

## Goals
- **Primary objective:** [objective]
- **Target audience:** [description]
\`\`\`

7. Keep the document concise but specific. Every rule should be actionable.`;
}

export function buildBootstrapInterviewPrompt(bootstrapData: string, existingPersona?: string): string {
  return `${buildInterviewSystemPrompt(existingPersona)}

## Bootstrap Data

The user's X account history has been analyzed. Use this data as a starting point for the interview — reference specific patterns you see, and ask the user if they want to continue in this direction or change it:

<bootstrap-data>
${bootstrapData}
</bootstrap-data>

Start by summarizing what you learned from their account history (2-3 sentences), then ask the first question that builds on or challenges what you found.`;
}
