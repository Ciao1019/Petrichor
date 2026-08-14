package config

import "testing"

func TestLoadAppURLUsesConfiguredValue(t *testing.T) {
	t.Setenv("APP_BASE_URL", "https://petrichor.example/base")
	if got := loadAppURL(); got != "https://petrichor.example/base" {
		t.Fatalf("loadAppURL() = %q", got)
	}

	t.Setenv("APP_BASE_URL", "")
	if got := loadAppURL(); got != "http://localhost:3000" {
		t.Fatalf("loadAppURL() default = %q", got)
	}
}

func TestLoadQuestionGenerationConcurrency(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://petrichor:test@127.0.0.1:5432/petrichor")

	t.Setenv("PETRICHOR_QUESTION_GENERATION_CONCURRENCY", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.QuestionGenerationConcurrency != DefaultQuestionGenerationConcurrency {
		t.Fatalf("默认并发数为 %d，实际 %d", DefaultQuestionGenerationConcurrency, cfg.QuestionGenerationConcurrency)
	}

	t.Setenv("PETRICHOR_QUESTION_GENERATION_CONCURRENCY", "35")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.QuestionGenerationConcurrency != 35 {
		t.Fatalf("配置并发数应为 35，实际 %d", cfg.QuestionGenerationConcurrency)
	}

	for _, invalid := range []string{"0", "101", "invalid"} {
		t.Setenv("PETRICHOR_QUESTION_GENERATION_CONCURRENCY", invalid)
		cfg, err = Load()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.QuestionGenerationConcurrency != DefaultQuestionGenerationConcurrency {
			t.Fatalf("非法配置 %q 应回退到 %d，实际 %d", invalid, DefaultQuestionGenerationConcurrency, cfg.QuestionGenerationConcurrency)
		}
	}
}
