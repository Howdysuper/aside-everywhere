from heyaside import spoken


def test_wake_words_are_stripped():
    assert spoken.strip_wake("Hey Jarvis, what's the weather?") == "what's the weather?"
    assert spoken.strip_wake("hey travis what time is it") == "what time is it"
    assert spoken.strip_wake("Hey Aside open my calendar") == "open my calendar"
    assert spoken.strip_wake("What's the weather") == "What's the weather"


def test_dismissals_end_but_requests_continue():
    for t in ["Thanks!", "That's all", "No, thank you.", "That'll be all, Jarvis.", "Goodnight", "bye"]:
        assert spoken.is_dismissal(t), t
    for t in ["thanks, now email it to me", "what about Friday", "Oh, that's cool."]:
        assert not spoken.is_dismissal(t), t


def test_intents_while_busy():
    assert spoken.intent("stop", True) == "stop"
    assert spoken.intent("cancel that", True) == "stop"
    assert spoken.intent("what are you doing right now?", True) == "status"
    assert spoken.intent("actually, check Friday instead", True) == "steer"
    assert spoken.intent("also add milk to the list", True) == "queue"
    assert spoken.intent("stop", False) == "new"


def test_spoken_answer_keeps_substance():
    a = "Here are the three due this week:\n---\n- Lab report due Tue 9 pm\n- Essay due Thu\n- Quiz due Fri 8 am\n"
    s = spoken.spoken_from(a)
    assert "Lab report" in s and "Essay" in s


def test_markdown_and_links_are_cleaned():
    s = spoken.spoken_from("**Done.** See [the doc](https://example.com/x) and `code`.")
    assert "**" not in s and "https" not in s and "the doc" in s


def test_long_answers_are_capped():
    s = spoken.spoken_from(" ".join(f"Sentence number {i} is here." for i in range(20)))
    assert s.endswith("The rest is in Aside.")


def test_first_chunk_is_short():
    c = spoken.speech_chunks("Leonardo da Vinci painted the Mona Lisa, sometime between fifteen oh three and fifteen nineteen in Florence. It hangs in the Louvre.")
    assert c[0] == "Leonardo da Vinci painted the Mona Lisa," and c[1].startswith("sometime")
