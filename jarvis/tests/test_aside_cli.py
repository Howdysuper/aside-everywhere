from heyaside import aside_cli as a

E = "\x1b"
RUN = (
    f"{E}[2mcreated new session: ses_ABC123{E}[0m\n"
    f"{E}[2mThinking: let me look{E}[0m\n"
    f"{E}[32mrepl{E}[0m(code: {E}[32m'await openTab(1)'{E}[39m, title: {E}[32m'Opening the calendar'{E}[39m){E}[2m [call_1]{E}[0m\n"
    f"{E}[32mread_file{E}[0m(path: {E}[32m'C:\\Users\\alex\\.aside\\u\\0\\skills\\user\\daily-planner\\SKILL.md'{E}[39m){E}[2m [call_2]{E}[0m\n"
    "You have two meetings tomorrow, sir: standup at 9 and design review at 2.\n"
)


def test_parse_finds_session_and_answer():
    r = a.parse(RUN)
    assert r.session_id == "ses_ABC123"
    assert r.answer.startswith("You have two meetings")
    assert r.error is None


def test_steps_have_human_titles():
    calls = a.tool_calls(RUN, final=True)
    assert [c.name for c in calls] == ["repl", "read_file"]
    assert a.step_title(calls[0].name, calls[0].args) == "Opening the calendar"


def test_skill_path_with_backslashes_still_titles():
    assert a.step_title("read_file", "path: '/x/skills/user/daily-planner/SKILL.md'") == "Using your Daily planner skill"


def test_argument_strings_are_not_tool_calls():
    raw = f"text {E}[32mrepl{E}[0m(not at line start\n"
    assert a.tool_calls(raw, final=True) == []


def test_errors_are_reported():
    r = a.parse(f"{E}[2mcreated new session: ses_X{E}[0m\n{E}[31mError{E}[0m: model unavailable\n")
    assert r.error == "model unavailable"


def test_uncoloured_output_still_works():
    r = a.parse("created new session: ses_PLAIN\nThe answer is 42.\n")
    assert r.session_id == "ses_PLAIN" and r.answer == "The answer is 42."
