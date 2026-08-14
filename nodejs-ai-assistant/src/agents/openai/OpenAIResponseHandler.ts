import OpenAI from "openai";
import type { Channel, Event, MessageResponse, StreamChat } from "stream-chat";

export class OpenAIResponseHandler {
  private message_text = "";
  private is_done = false;
  private last_update_time = 0;
  private abortController = new AbortController();

  constructor(
    private readonly openai: OpenAI,
    private readonly messages: OpenAI.Chat.ChatCompletionMessageParam[],
    private readonly model: string,
    private readonly chatClient: StreamChat,
    private readonly channel: Channel,
    private readonly message: MessageResponse,
    private readonly onDispose: () => void
  ) {
    this.chatClient.on("ai_indicator.stop", this.handleStopGenerating);
  }

  run = async () => {
    const { cid, id: message_id } = this.message;
    let isCompleted = false;

    const tools: OpenAI.Chat.ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "web_search",
          description:
            "Search the web for current information, news, facts, or research on any topic",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The search query to find information about",
              },
            },
            required: ["query"],
          },
        },
      },
    ];

    try {
      while (!isCompleted && !this.is_done) {
        await this.channel.sendEvent({
          type: "ai_indicator.update",
          ai_state: "AI_STATE_GENERATING",
          cid: cid,
          message_id: message_id,
        });

        const stream = await this.openai.chat.completions.create(
          {
            model: this.model,
            messages: this.messages,
            stream: true,
            tools: tools,
            temperature: 0.7,
          },
          { signal: this.abortController.signal }
        );

        let toolCallsAccumulator: any[] = [];
        let hasContent = false;

        for await (const chunk of stream) {
          if (this.is_done) break;

          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            hasContent = true;
            this.message_text += delta.content;
            const now = Date.now();
            if (now - this.last_update_time > 1000) {
              await this.chatClient.partialUpdateMessage(message_id, {
                set: { text: this.message_text },
              });
              this.last_update_time = now;
            }
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index === undefined) continue;
              if (!toolCallsAccumulator[tc.index]) {
                toolCallsAccumulator[tc.index] = {
                  id: tc.id || "",
                  type: "function",
                  function: { name: tc.function?.name || "", arguments: "" },
                };
              }
              if (tc.id) {
                toolCallsAccumulator[tc.index].id = tc.id;
              }
              if (tc.function?.name) {
                toolCallsAccumulator[tc.index].function.name = tc.function.name;
              }
              if (tc.function?.arguments) {
                toolCallsAccumulator[tc.index].function.arguments +=
                  tc.function.arguments;
              }
            }
          }
        }

        if (this.is_done) break;

        // Clean up undefined elements from accumulator if any
        const toolCalls = toolCallsAccumulator.filter(Boolean);

        if (toolCalls.length > 0) {
          // Push tool request message
          this.messages.push({
            role: "assistant",
            content: null,
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            })),
          });

          await this.channel.sendEvent({
            type: "ai_indicator.update",
            ai_state: "AI_STATE_EXTERNAL_SOURCES",
            cid: cid,
            message_id: message_id,
          });

          for (const toolCall of toolCalls) {
            if (toolCall.function.name === "web_search") {
              try {
                const args = JSON.parse(toolCall.function.arguments);
                const searchResult = await this.performWebSearch(args.query);
                this.messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: searchResult,
                });
              } catch (e) {
                console.error(
                  "Error parsing tool arguments or performing web search",
                  e
                );
                this.messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: JSON.stringify({ error: "failed to call tool" }),
                });
              }
            } else {
              this.messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: JSON.stringify({ error: "unknown tool" }),
              });
            }
          }
        } else {
          isCompleted = true;
        }
      }

      if (!this.is_done) {
        await this.chatClient.partialUpdateMessage(message_id, {
          set: { text: this.message_text },
        });
        await this.channel.sendEvent({
          type: "ai_indicator.clear",
          cid: cid,
          message_id: message_id,
        });
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.message.includes("abort"))
      ) {
        console.log("Stream generation aborted successfully");
      } else {
        console.error("An error occurred during the run:", error);
        await this.handleError(error as Error);
      }
    } finally {
      await this.dispose();
    }
  };

  dispose = async () => {
    if (this.is_done) {
      return;
    }
    this.is_done = true;
    this.chatClient.off("ai_indicator.stop", this.handleStopGenerating);
    this.onDispose();
  };

  private handleStopGenerating = async (event: Event) => {
    if (this.is_done || event.message_id !== this.message.id) {
      return;
    }

    console.log("Stop generating for message", this.message.id);
    this.abortController.abort();

    await this.channel.sendEvent({
      type: "ai_indicator.clear",
      cid: this.message.cid,
      message_id: this.message.id,
    });
    await this.dispose();
  };

  private handleError = async (error: Error) => {
    if (this.is_done) {
      return;
    }
    await this.channel.sendEvent({
      type: "ai_indicator.update",
      ai_state: "AI_STATE_ERROR",
      cid: this.message.cid,
      message_id: this.message.id,
    });
    await this.chatClient.partialUpdateMessage(this.message.id, {
      set: {
        text: error.message ?? "Error generating the message",
        message: error.toString(),
      },
    });
    await this.dispose();
  };

  private performWebSearch = async (query: string): Promise<string> => {
    const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

    if (!TAVILY_API_KEY) {
      return JSON.stringify({
        error: "Web search is not available. API key not configured.",
      });
    }

    console.log(`Performing web search for: "${query}"`);

    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TAVILY_API_KEY}`,
        },
        body: JSON.stringify({
          query: query,
          search_depth: "advanced",
          max_results: 5,
          include_answer: true,
          include_raw_content: false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Tavily search failed for query "${query}":`, errorText);
        return JSON.stringify({
          error: `Search failed with status: ${response.status}`,
          details: errorText,
        });
      }

      const data = await response.json();
      console.log(`Tavily search successful for query "${query}"`);

      return JSON.stringify(data);
    } catch (error) {
      console.error(
        `An exception occurred during web search for "${query}":`,
        error
      );
      return JSON.stringify({
        error: "An exception occurred during the search.",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };
}
